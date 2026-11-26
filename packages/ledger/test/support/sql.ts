/**
 * Test-only SQL, as named constants, the same rule as `src/infrastructure/pg/queries.ts`.
 * Anything the application itself runs is NOT repeated here: tests use the production constants
 * (`ledgerQueries`, `migrationQueries`, `unitOfWork`) so the guards are proven against the exact
 * statements the app sends. What is left is inspection (reading catalogs and settings) and the
 * attacks the guards must stop.
 */

/** Reads the tests make to check an outcome. */
export const inspect = {
  /** $1 scope. */
  journalRowsInScope: `SELECT count(*)::int AS n
    FROM ledger.journal_entries e JOIN ledger.accounts a ON a.id = e.account_id
    WHERE a.scope = $1`,
  /** $1 key. */
  keyRows: 'SELECT count(*)::int AS n FROM ledger.idempotency_keys WHERE key = $1',
  /** $1 constraint name in schema ledger. */
  constraintDef: `SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = 'ledger' AND c.conname = $1`,
  ledgerTables: `SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'ledger' ORDER BY 1`,
  ledgerFunctions: `SELECT p.proname, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ledger' ORDER BY 1`,
  /** Grants of TEMPORARY to PUBLIC (grantee 0) on the current database. */
  publicTempGrants: `SELECT count(*)::int AS n FROM pg_database d, aclexplode(d.datacl) a
    WHERE d.datname = current_database() AND a.grantee = 0 AND a.privilege_type = 'TEMPORARY'`,
  timeouts: `SELECT current_setting('lock_timeout') AS lock,
    current_setting('statement_timeout') AS statement,
    current_setting('idle_in_transaction_session_timeout') AS idle`,
  isolation: "SELECT current_setting('transaction_isolation') AS level",
  lockTimeout: "SELECT current_setting('lock_timeout') AS t",
  /** $1 lock key. Never waits: true when the lock was free (and is now held until commit). */
  tryXactLock: 'SELECT pg_try_advisory_xact_lock($1::bigint) AS free',
  /** $1 namespace, $2 key: the two-int form the migration lock uses. */
  tryMigrationLock: 'SELECT pg_try_advisory_lock($1::int, $2::int) AS free',
  unlockAll: 'SELECT pg_advisory_unlock_all()',
} as const;

/** Statements the guards must reject or survive. Each is a test case of its own. */
export const attacks = {
  /** Every way to change or erase history, on every ledger table. */
  mutations: [
    'UPDATE ledger.journal_entries SET amount_base_units = 1',
    'DELETE FROM ledger.journal_entries',
    'TRUNCATE ledger.journal_entries',
    'UPDATE ledger.transactions SET kind = kind',
    'DELETE FROM ledger.transactions',
    'TRUNCATE ledger.transactions CASCADE',
    "UPDATE ledger.idempotency_keys SET request_hash = 'x'",
    'DELETE FROM ledger.idempotency_keys',
    'TRUNCATE ledger.idempotency_keys',
    "UPDATE ledger.accounts SET kind = 'authorized' WHERE kind = 'reserved'",
    'DELETE FROM ledger.accounts',
    'TRUNCATE ledger.accounts CASCADE',
    "UPDATE ledger.scopes SET currency = 'INR'",
    'DELETE FROM ledger.scopes',
    'TRUNCATE ledger.scopes CASCADE',
  ],
  /** Switches ordinary triggers off for this session (superuser only). */
  replicaModeOn: 'SET session_replication_role = replica',
  replicaModeOff: 'RESET session_replication_role',
  /** A temporary table that would shadow ledger.transactions for an unqualified name. */
  shadowTransactions: 'CREATE TEMP TABLE transactions (id uuid, created_xid xid8)',
  /** $1 txn id: claims "this database transaction created it". */
  forgeCreatedByMe: 'INSERT INTO pg_temp.transactions VALUES ($1, pg_current_xact_id())',
} as const;

/** Identifiers cannot be bound parameters, so only generated, checked names are accepted. */
const safeName = (name: string): string => {
  if (!/^[a-z0-9_]{1,63}$/.test(name)) throw new Error(`unsafe database name: ${name}`);
  return name;
};

export const admin = {
  createDatabase: (name: string): string => `CREATE DATABASE ${safeName(name)}`,
  dropDatabase: (name: string): string => `DROP DATABASE ${safeName(name)} WITH (FORCE)`,
} as const;

/** Postgres error code for a CHECK constraint violation. */
export const CHECK_VIOLATION = '23514';
/** A request hash the schema accepts (64 lowercase hex characters). */
export const VALID_HASH = 'a'.repeat(64);
/** The migration lock, as `[namespace, key]`. */
export const MIGRATION_LOCK = [7265, 1] as const;
