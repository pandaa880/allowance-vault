import { Pool, type PoolClient } from 'pg';
import type {
  KeyClaim,
  LedgerRepository,
  LedgerTx,
  NewTransaction,
} from '../../application/ports.js';
import { CurrencyMismatch, LockTimeout } from '../../domain/errors.js';
import { touchedScopes, type AccountKind, type Totals } from '../../domain/journal.js';
import { asError, isRetryable, LOCK_NOT_AVAILABLE, pgErrorCode } from './pg-errors.js';
import { accountParams, entryParams, scopeParams } from './params.js';
import { ledgerQueries, unitOfWork } from './queries.js';
import { parseIdempotencyRows, parseLockKeyRows, parseTotalsRows } from './rows.js';

/**
 * Money never passes through a JS number: amounts are sent as strings into `::bigint[]`, and
 * every bigint read (`sum(...)`) is cast to `::text` in SQL and parsed with `BigInt`. So the
 * pool needs no custom int8 type parser.
 */
export function createPgPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export interface PgLedgerOptions {
  /** Longest a posting waits for a scope lock held by someone else. */
  readonly lockTimeout?: string;
  readonly statementTimeout?: string;
  /** Longest a connection may sit idle inside an open transaction (a stuck worker). */
  readonly idleInTransactionTimeout?: string;
  /** Attempts per unit of work for deadlock, serialization and lock-timeout failures. */
  readonly maxAttempts?: number;
}

const DEFAULTS = {
  lockTimeout: '5s',
  statementTimeout: '15s',
  idleInTransactionTimeout: '30s',
  maxAttempts: 3,
} as const;

class PgLedgerTx implements LedgerTx {
  constructor(private readonly client: PoolClient) {}

  async lockScopes(scopes: readonly string[]): Promise<void> {
    // The database orders the lock keys, so the order is the same for every writer.
    const keys = await this.client.query(ledgerQueries.scopeLockKeys, [[...scopes]]);
    for (const { key } of parseLockKeyRows(keys.rows)) {
      await this.client.query(ledgerQueries.lockKey, [key]);
    }
  }

  async claimIdempotencyKey(key: string, requestHash: string, txnId: string): Promise<KeyClaim> {
    // A concurrent insert of the same key blocks until the other transaction ends, so the
    // follow-up SELECT always sees the winner's row (READ COMMITTED: fresh snapshot per statement).
    const inserted = await this.client.query(ledgerQueries.claimIdempotencyKey, [
      key,
      requestHash,
      txnId,
    ]);
    if (inserted.rowCount === 1) return { outcome: 'claimed' };
    const existing = await this.client.query(ledgerQueries.findIdempotencyKey, [key]);
    const [row] = parseIdempotencyRows(existing.rows);
    if (!row) throw new Error(`idempotency key ${key} vanished after a conflict`);
    return { outcome: 'exists', requestHash: row.request_hash, txnId: row.txn_id };
  }

  async insertTransaction(txn: NewTransaction): Promise<void> {
    await this.ensureScopesAndAccounts(txn);
    await this.client.query(ledgerQueries.insertTransaction, [txn.id, txn.kind, txn.claimId]);
    await this.client.query(ledgerQueries.insertEntries, entryParams(txn));
  }

  /**
   * Creates missing scopes and accounts, then checks that every touched scope holds one
   * currency (a scope never mixes USDC micro-units with paise). The database enforces the same
   * rule with a composite foreign key; this check turns the violation into a domain error.
   */
  private async ensureScopesAndAccounts(txn: NewTransaction): Promise<void> {
    await this.client.query(ledgerQueries.insertScopes, scopeParams(txn));
    const mixed = await this.client.query(ledgerQueries.findMixedCurrency, [
      touchedScopes(txn.entries),
      txn.currency,
    ]);
    if (mixed.rowCount) {
      throw new CurrencyMismatch(
        txn.currency,
        `transaction ${txn.id} is in ${txn.currency} but a touched scope already holds another currency`,
      );
    }
    await this.client.query(ledgerQueries.insertAccounts, accountParams(txn));
  }

  async scopeTotals(scope: string): Promise<Partial<Record<AccountKind, Totals>>> {
    const { rows } = await this.client.query(ledgerQueries.scopeTotals, [scope]);
    const totals: Partial<Record<AccountKind, Totals>> = {};
    for (const row of parseTotalsRows(rows)) {
      const entry = (totals[row.kind] ??= { debits: 0n, credits: 0n });
      if (row.direction === 'debit') entry.debits = BigInt(row.total);
      else entry.credits = BigInt(row.total);
    }
    return totals;
  }
}

export class PgLedgerRepository implements LedgerRepository {
  private readonly options: Required<PgLedgerOptions>;

  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    options: PgLedgerOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  async withTransaction<T>(work: (tx: LedgerTx) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runOnce(work);
      } catch (error) {
        const code = pgErrorCode(error);
        // Nothing was committed, and a repeat is safe: a posting is protected by its
        // idempotency key, and reads change nothing.
        if (isRetryable(code) && attempt < this.options.maxAttempts) continue;
        if (code === LOCK_NOT_AVAILABLE) {
          throw new LockTimeout(`gave up waiting for a scope lock after ${attempt} attempt(s)`, {
            cause: error,
          });
        }
        throw error;
      }
    }
  }

  private async runOnce<T>(work: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let rollbackFailure: Error | undefined;
    try {
      await client.query(unitOfWork.begin);
      await client.query(unitOfWork.setTimeouts, [
        this.options.lockTimeout,
        this.options.statementTimeout,
        this.options.idleInTransactionTimeout,
      ]);
      const result = await work(new PgLedgerTx(client));
      await client.query(unitOfWork.commit);
      return result;
    } catch (error) {
      await client.query(unitOfWork.rollback).catch((failure: unknown) => {
        rollbackFailure = asError(failure);
      });
      throw error;
    } finally {
      // A client whose ROLLBACK failed may still be inside a transaction: destroy it.
      client.release(rollbackFailure);
    }
  }
}
