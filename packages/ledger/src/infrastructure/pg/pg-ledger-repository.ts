import pg from "pg";
import type { KeyClaim, LedgerRepository, LedgerTx, NewTransaction } from "../../application/ports.js";
import { CurrencyMismatch } from "../../domain/errors.js";
import { accountId, type AccountKind, type Totals } from "../../domain/journal.js";

const INT8_OID = 20;

/** Pool that returns int8 columns as bigint, so base units never pass through a JS number. */
export function createPgPool(connectionString: string): pg.Pool {
  return new pg.Pool({
    connectionString,
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === INT8_OID ? BigInt : pg.types.getTypeParser(oid, format as "text")) as typeof pg.types.getTypeParser,
    },
  });
}

class PgLedgerTx implements LedgerTx {
  constructor(private readonly client: pg.PoolClient) {}

  async lockScope(scope: string): Promise<void> {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
  }

  async claimIdempotencyKey(key: string, requestHash: string, txnId: string): Promise<KeyClaim> {
    // A concurrent insert of the same key blocks until the other transaction ends, so the
    // follow-up SELECT always sees the winner's row.
    const inserted = await this.client.query(
      `INSERT INTO idempotency_keys (key, request_hash, txn_id) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO NOTHING`,
      [key, requestHash, txnId],
    );
    if (inserted.rowCount === 1) return { outcome: "claimed" };
    const existing = await this.client.query<{ request_hash: string; txn_id: string }>(
      "SELECT request_hash, txn_id FROM idempotency_keys WHERE key = $1",
      [key],
    );
    const row = existing.rows[0];
    if (!row) throw new Error(`idempotency key ${key} vanished after a conflict`);
    return { outcome: "exists", requestHash: row.request_hash, txnId: row.txn_id };
  }

  async insertTransaction(txn: NewTransaction): Promise<void> {
    const ids = txn.entries.map((e) => accountId(e.account));
    await this.client.query(
      `INSERT INTO accounts (id, scope, kind, currency)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) ON CONFLICT (id) DO NOTHING`,
      [
        ids,
        txn.entries.map((e) => e.account.scope),
        txn.entries.map((e) => e.account.kind),
        txn.entries.map(() => txn.currency),
      ],
    );
    const mismatched = await this.client.query(
      "SELECT 1 FROM accounts WHERE id = ANY($1::text[]) AND currency <> $2",
      [ids, txn.currency],
    );
    if (mismatched.rowCount) throw new CurrencyMismatch(`an account in ${txn.id} uses another currency than ${txn.currency}`);
    await this.client.query("INSERT INTO transactions (id, kind, claim_id) VALUES ($1, $2, $3)", [
      txn.id,
      txn.kind,
      txn.claimId,
    ]);
    await this.client.query(
      `INSERT INTO journal_entries (txn_id, account_id, direction, amount_base_units)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bigint[])`,
      [txn.id, ids, txn.entries.map((e) => e.direction), txn.entries.map((e) => e.amount.toString())],
    );
  }

  async scopeTotals(scope: string): Promise<Partial<Record<AccountKind, Totals>>> {
    // sum() is numeric; read it as text so a large total cannot lose precision.
    const { rows } = await this.client.query<{ kind: AccountKind; direction: string; total: string }>(
      `SELECT a.kind, e.direction, sum(e.amount_base_units)::text AS total
         FROM journal_entries e JOIN accounts a ON a.id = e.account_id
        WHERE a.scope = $1 GROUP BY a.kind, e.direction`,
      [scope],
    );
    const totals: Partial<Record<AccountKind, Totals>> = {};
    for (const row of rows) {
      const entry = (totals[row.kind] ??= { debits: 0n, credits: 0n });
      if (row.direction === "debit") entry.debits = BigInt(row.total);
      else entry.credits = BigInt(row.total);
    }
    return totals;
  }
}

export class PgLedgerRepository implements LedgerRepository {
  constructor(private readonly pool: pg.Pool) {}

  async withTransaction<T>(work: (tx: LedgerTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new PgLedgerTx(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
