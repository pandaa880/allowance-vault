import { Pool, type PoolClient } from 'pg';
import type {
  KeyClaim,
  LedgerRepository,
  LedgerTx,
  NewTransaction,
} from '../../application/ports.js';
import { CurrencyMismatch } from '../../domain/errors.js';
import type { AccountKind, Totals } from '../../domain/journal.js';
import { accountParams, entryParams, touchedScopes } from './params.js';
import { ledgerQueries, unitOfWork } from './queries.js';

/**
 * Money never passes through a JS number: amounts are sent as strings into `::bigint[]`, and
 * every bigint read (`sum(...)`) is cast to `::text` in SQL and parsed with `BigInt`. So the
 * pool needs no custom int8 type parser.
 */
export function createPgPool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

class PgLedgerTx implements LedgerTx {
  constructor(private readonly client: PoolClient) {}

  async lockScope(scope: string): Promise<void> {
    await this.client.query(ledgerQueries.lockScope, [scope]);
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
    const existing = await this.client.query<{ request_hash: string; txn_id: string }>(
      ledgerQueries.findIdempotencyKey,
      [key],
    );
    const row = existing.rows[0];
    if (!row) throw new Error(`idempotency key ${key} vanished after a conflict`);
    return { outcome: 'exists', requestHash: row.request_hash, txnId: row.txn_id };
  }

  async insertTransaction(txn: NewTransaction): Promise<void> {
    await this.ensureAccounts(txn);
    await this.client.query(ledgerQueries.insertTransaction, [txn.id, txn.kind, txn.claimId]);
    await this.client.query(ledgerQueries.insertEntries, entryParams(txn));
  }

  /**
   * Creates missing accounts, then checks that every account in the touched scopes uses one
   * currency (a scope never mixes USDC micro-units with paise).
   */
  private async ensureAccounts(txn: NewTransaction): Promise<void> {
    await this.client.query(ledgerQueries.insertAccounts, accountParams(txn));
    const mixed = await this.client.query(ledgerQueries.findMixedCurrency, [
      touchedScopes(txn),
      txn.currency,
    ]);
    if (mixed.rowCount) {
      throw new CurrencyMismatch(
        `transaction ${txn.id} is in ${txn.currency} but a touched scope already holds another currency`,
      );
    }
  }

  async scopeTotals(scope: string): Promise<Partial<Record<AccountKind, Totals>>> {
    const { rows } = await this.client.query<{
      kind: AccountKind;
      direction: string;
      total: string;
    }>(ledgerQueries.scopeTotals, [scope]);
    const totals: Partial<Record<AccountKind, Totals>> = {};
    for (const row of rows) {
      const entry = (totals[row.kind] ??= { debits: 0n, credits: 0n });
      if (row.direction === 'debit') entry.debits = BigInt(row.total);
      else entry.credits = BigInt(row.total);
    }
    return totals;
  }
}

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly pool: Pool) {}

  async withTransaction<T>(work: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let rollbackFailure: Error | undefined;
    try {
      await client.query(unitOfWork.begin);
      const result = await work(new PgLedgerTx(client));
      await client.query(unitOfWork.commit);
      return result;
    } catch (error) {
      await client.query(unitOfWork.rollback).catch((failure: Error) => {
        rollbackFailure = failure;
      });
      throw error;
    } finally {
      // A client whose ROLLBACK failed may still be inside a transaction: destroy it.
      client.release(rollbackFailure);
    }
  }
}
