import { Pool, type PoolClient } from 'pg';
import type {
  KeyClaim,
  LedgerRepository,
  LedgerTx,
  NewTransaction,
} from '../../application/ports.js';
import { CurrencyMismatch } from '../../domain/errors.js';
import { accountId, type AccountKind, type Totals } from '../../domain/journal.js';

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
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope]);
  }

  async claimIdempotencyKey(key: string, requestHash: string, txnId: string): Promise<KeyClaim> {
    // A concurrent insert of the same key blocks until the other transaction ends, so the
    // follow-up SELECT always sees the winner's row (READ COMMITTED: fresh snapshot per statement).
    const inserted = await this.client.query(
      `INSERT INTO idempotency_keys (key, request_hash, txn_id) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, requestHash, txnId],
    );
    if (inserted.rowCount === 1) return { outcome: 'claimed' };
    const existing = await this.client.query<{ request_hash: string; txn_id: string }>(
      'SELECT request_hash, txn_id FROM idempotency_keys WHERE key = $1',
      [key],
    );
    const row = existing.rows[0];
    if (!row) throw new Error(`idempotency key ${key} vanished after a conflict`);
    return { outcome: 'exists', requestHash: row.request_hash, txnId: row.txn_id };
  }

  async insertTransaction(txn: NewTransaction): Promise<void> {
    await this.ensureAccounts(txn);
    await this.client.query('INSERT INTO transactions (id, kind, claim_id) VALUES ($1, $2, $3)', [
      txn.id,
      txn.kind,
      txn.claimId,
    ]);
    await this.client.query(
      `INSERT INTO journal_entries (txn_id, account_id, direction, amount_base_units)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bigint[])`,
      [
        txn.id,
        txn.entries.map((e) => accountId(e.account)),
        txn.entries.map((e) => e.direction),
        txn.entries.map((e) => e.amount.toString()),
      ],
    );
  }

  /**
   * Creates missing accounts, sorted by id so two writers touching the same new accounts take
   * row locks in the same order (no 40P01 deadlock), then checks that every account in the
   * touched scopes uses one currency (a scope never mixes USDC micro-units with paise).
   */
  private async ensureAccounts(txn: NewTransaction): Promise<void> {
    const accounts = new Map(txn.entries.map((e) => [accountId(e.account), e.account]));
    const ids = [...accounts.keys()].toSorted();
    await this.client.query(
      `INSERT INTO accounts (id, scope, kind, currency)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
       ON CONFLICT (id) DO NOTHING`,
      [
        ids,
        ids.map((id) => accounts.get(id)?.scope),
        ids.map((id) => accounts.get(id)?.kind),
        ids.map(() => txn.currency),
      ],
    );
    const scopes = [...new Set([...accounts.values()].map((a) => a.scope))];
    const mixed = await this.client.query(
      'SELECT 1 FROM accounts WHERE scope = ANY($1::text[]) AND currency <> $2',
      [scopes, txn.currency],
    );
    if (mixed.rowCount) {
      throw new CurrencyMismatch(
        `transaction ${txn.id} is in ${txn.currency} but a touched scope already holds another currency`,
      );
    }
  }

  async scopeTotals(scope: string): Promise<Partial<Record<AccountKind, Totals>>> {
    // sum() is numeric; read it as text so a large total cannot lose precision.
    const { rows } = await this.client.query<{
      kind: AccountKind;
      direction: string;
      total: string;
    }>(
      `SELECT a.kind, e.direction, sum(e.amount_base_units)::text AS total
         FROM journal_entries e JOIN accounts a ON a.id = e.account_id
        WHERE a.scope = $1 GROUP BY a.kind, e.direction`,
      [scope],
    );
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
      // Pinned, not inherited from the server default: the per-scope lock plus a fresh snapshot
      // per statement is what makes read-check-write safe. Under REPEATABLE READ the snapshot
      // would be taken before the lock wait and two reserves could both pass the cap check.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const result = await work(new PgLedgerTx(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch((failure: Error) => {
        rollbackFailure = failure;
      });
      throw error;
    } finally {
      // A client whose ROLLBACK failed may still be inside a transaction: destroy it.
      client.release(rollbackFailure);
    }
  }
}
