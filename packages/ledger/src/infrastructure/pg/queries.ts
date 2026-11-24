/**
 * Every SQL statement the ledger runs, as a named constant. Nothing else in the package writes
 * SQL inline, so each statement can be read in one place and exercised on its own (see
 * `test/integration/queries.test.ts`). Parameters are always bound (`$1`, ...), never interpolated.
 *
 * Money: amounts go in as strings cast with `::bigint[]`; sums come out cast `::text`.
 */

/** Unit of work. The isolation level is pinned, not inherited from the server default: the
 * per-scope lock plus a fresh snapshot per statement is what makes read-check-write safe. Under
 * REPEATABLE READ the snapshot is taken before the lock wait and two reserves could both pass. */
export const unitOfWork = {
  begin: 'BEGIN ISOLATION LEVEL READ COMMITTED',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
} as const;

export const ledgerQueries = {
  /** $1 scope. Held until the transaction ends. */
  lockScope: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',

  /** $1 key, $2 request hash, $3 txn id. rowCount 1 = claimed, 0 = the key already exists. A
   * concurrent insert of the same key blocks until the other transaction ends. */
  claimIdempotencyKey: `INSERT INTO idempotency_keys (key, request_hash, txn_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (key) DO NOTHING`,

  /** $1 key. */
  findIdempotencyKey: 'SELECT request_hash, txn_id FROM idempotency_keys WHERE key = $1',

  /** $1 ids, $2 scopes, $3 kinds, $4 currencies (parallel arrays, ids sorted by the caller so two
   * writers lock new rows in the same order). */
  insertAccounts: `INSERT INTO accounts (id, scope, kind, currency)
    SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
    ON CONFLICT (id) DO NOTHING`,

  /** $1 scopes, $2 currency. Any row means a touched scope already holds another currency. */
  findMixedCurrency: 'SELECT 1 FROM accounts WHERE scope = ANY($1::text[]) AND currency <> $2',

  /** $1 id, $2 kind, $3 claim id. */
  insertTransaction: 'INSERT INTO transactions (id, kind, claim_id) VALUES ($1, $2, $3)',

  /** $1 txn id, $2 account ids, $3 directions, $4 amounts (parallel arrays). */
  insertEntries: `INSERT INTO journal_entries (txn_id, account_id, direction, amount_base_units)
    SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bigint[])`,

  /** $1 scope. `total` is text so a large sum cannot lose precision. */
  scopeTotals: `SELECT a.kind, e.direction, sum(e.amount_base_units)::text AS total
    FROM journal_entries e JOIN accounts a ON a.id = e.account_id
    WHERE a.scope = $1
    GROUP BY a.kind, e.direction`,
} as const;

export const migrationQueries = {
  /** $1 lock number. Session-level, so concurrent runners take turns. */
  lock: 'SELECT pg_advisory_lock($1)',
  unlock: 'SELECT pg_advisory_unlock($1)',
  createTable: `CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now())`,
  listApplied: 'SELECT name FROM schema_migrations',
  /** $1 file name. */
  record: 'INSERT INTO schema_migrations (name) VALUES ($1)',
} as const;
