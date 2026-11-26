/**
 * Every SQL statement the ledger runs, as a named constant. Nothing else in the package writes
 * SQL inline, so each statement can be read in one place and exercised on its own (see
 * `test/integration/queries.test.ts`). Parameters are always bound (`$1`, ...), never interpolated.
 * Tables are always named with their schema (`ledger.`), never through the session's search_path.
 *
 * Money: amounts go in as strings cast with `::bigint[]`; sums come out cast `::text`.
 */

/** Unit of work. The isolation level is pinned, not inherited from the server default: the
 * per-scope lock plus a fresh snapshot per statement is what makes read-check-write safe. Under
 * REPEATABLE READ the snapshot is taken before the lock wait and two reserves could both pass. */
export const unitOfWork = {
  begin: 'BEGIN ISOLATION LEVEL READ COMMITTED',
  /** $1 lock timeout, $2 statement timeout, $3 idle-in-transaction timeout (Postgres duration
   * strings). Transaction-local, so nothing leaks into the pooled connection. Without them one
   * stuck connection holding a scope lock would queue every later writer and drain the pool. */
  setTimeouts: `SELECT
    set_config('lock_timeout', $1, true),
    set_config('statement_timeout', $2, true),
    set_config('idle_in_transaction_session_timeout', $3, true)`,
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
} as const;

export const ledgerQueries = {
  /** $1 scopes. Distinct lock keys, ascending. Locks must be taken in key order, not scope-name
   * order: two scopes can hash to the same 64-bit key (about 2^-64 per pair, harmless on its own),
   * and an order by name would then no longer be a consistent order and could deadlock. */
  scopeLockKeys: `SELECT key::text AS key
    FROM (SELECT DISTINCT hashtextextended(s, 0) AS key FROM unnest($1::text[]) AS s) AS k
    ORDER BY k.key`,

  /** $1 key (from `scopeLockKeys`). Held until the transaction ends. Shares the single-bigint
   * advisory keyspace with nothing else: the migration lock uses the two-int form. */
  lockKey: 'SELECT pg_advisory_xact_lock($1::bigint)',

  /** $1 key, $2 request hash, $3 txn id. rowCount 1 = claimed, 0 = the key already exists. A
   * concurrent insert of the same key blocks until the other transaction ends. */
  claimIdempotencyKey: `INSERT INTO ledger.idempotency_keys (key, request_hash, txn_id)
    VALUES ($1, $2, $3)
    ON CONFLICT (key) DO NOTHING`,

  /** $1 key. */
  findIdempotencyKey: 'SELECT request_hash, txn_id FROM ledger.idempotency_keys WHERE key = $1',

  /** $1 scopes, $2 currencies (parallel arrays, scopes sorted by the caller). */
  insertScopes: `INSERT INTO ledger.scopes (scope, currency)
    SELECT * FROM unnest($1::text[], $2::text[])
    ON CONFLICT (scope) DO NOTHING`,

  /** $1 scopes, $2 currency. Any row means a touched scope already holds another currency. The
   * database enforces the same rule through the composite foreign key on accounts. */
  findMixedCurrency: 'SELECT 1 FROM ledger.scopes WHERE scope = ANY($1::text[]) AND currency <> $2',

  /** $1 ids, $2 scopes, $3 kinds, $4 currencies (parallel arrays, ids sorted by the caller so two
   * writers lock new rows in the same order). */
  insertAccounts: `INSERT INTO ledger.accounts (id, scope, kind, currency)
    SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
    ON CONFLICT (id) DO NOTHING`,

  /** $1 id, $2 kind, $3 claim id. */
  insertTransaction: 'INSERT INTO ledger.transactions (id, kind, claim_id) VALUES ($1, $2, $3)',

  /** $1 txn id, $2 account ids, $3 directions, $4 amounts (parallel arrays). */
  insertEntries: `INSERT INTO ledger.journal_entries (txn_id, account_id, direction, amount_base_units)
    SELECT $1, * FROM unnest($2::text[], $3::text[], $4::bigint[])`,

  /** $1 scope. `total` is text so a large sum cannot lose precision. */
  scopeTotals: `SELECT a.kind, e.direction, sum(e.amount_base_units)::text AS total
    FROM ledger.journal_entries e JOIN ledger.accounts a ON a.id = e.account_id
    WHERE a.scope = $1
    GROUP BY a.kind, e.direction`,
} as const;

/** Migrations own their transaction statements, so changing the ledger's isolation level above
 * never silently changes how DDL runs. */
export const migrationQueries = {
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
  /** $1 timeout. Transaction-local: an ALTER waiting for its exclusive lock queues every writer
   * behind it, so it must give up quickly instead. */
  setLockTimeout: "SELECT set_config('lock_timeout', $1, true)",
  /** $1 timeout. Session-level, for the steps before the per-file transactions: waiting for the
   * migration lock and creating the bookkeeping table. Without it a second migrator (a CI retry,
   * a script run twice) would wait forever. Reset before the client goes back to the pool. */
  setSessionLockTimeout: "SELECT set_config('lock_timeout', $1, false)",
  resetLockTimeout: 'RESET lock_timeout',
  /** $1 namespace, $2 key. The two-int form is a separate keyspace from the single-bigint locks
   * the ledger takes per scope. Session-level, so it needs a direct (non-pooled) connection. */
  lock: 'SELECT pg_advisory_lock($1::int, $2::int)',
  unlock: 'SELECT pg_advisory_unlock($1::int, $2::int)',
  createTable: `CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now())`,
  listApplied: 'SELECT name FROM schema_migrations',
  /** $1 file name. */
  record: 'INSERT INTO schema_migrations (name) VALUES ($1)',
} as const;
