import { readdir, readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { asError } from './pg-errors.js';
import { migrationQueries } from './queries.js';
import { parseNameRows } from './rows.js';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
/** Two-int advisory lock: a keyspace of its own, apart from the ledger's per-scope locks. */
const MIGRATION_LOCK = [7265, 1] as const;
/** An ALTER waiting for its exclusive lock queues every writer behind it; give up quickly. */
const MIGRATION_LOCK_TIMEOUT = '3s';

/** One migration file in its own transaction: the DDL, the lock timeout and the record commit together. */
async function applyMigration(client: PoolClient, file: string): Promise<void> {
  const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
  try {
    await client.query(migrationQueries.begin);
    await client.query(migrationQueries.setLockTimeout, [MIGRATION_LOCK_TIMEOUT]);
    await client.query(sql);
    await client.query(migrationQueries.record, [file]);
    await client.query(migrationQueries.commit);
  } catch (error) {
    await client.query(migrationQueries.rollback).catch(() => undefined); // keep the original error
    throw error;
  }
}

/**
 * Applies numbered `.sql` files in order, once each. Run it over a direct connection, not a
 * transaction-mode pooler: the session lock must stay on one server connection.
 */
export async function migrate(pool: Pick<Pool, 'connect'>): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  let failure: Error | undefined;
  try {
    await client.query(migrationQueries.lock, [...MIGRATION_LOCK]);
    await client.query(migrationQueries.createTable);
    const done = new Set(
      parseNameRows((await client.query(migrationQueries.listApplied)).rows).map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).toSorted();
    for (const file of files) {
      if (done.has(file)) continue;
      await applyMigration(client, file);
      applied.push(file);
    }
  } catch (error) {
    failure = asError(error);
    throw error;
  } finally {
    try {
      const unlocked = await client.query(migrationQueries.unlock, [...MIGRATION_LOCK]);
      if (unlocked.rows[0]?.pg_advisory_unlock !== true) {
        failure ??= new Error('the migration lock was not held when unlocking');
      }
    } catch (error) {
      failure ??= asError(error);
    }
    // After any failure the session may still hold the lock: destroy the client, which makes the
    // server drop it, instead of returning it to the pool where every later migrate() would hang.
    client.release(failure);
  }
  return applied;
}
