import { readdir, readFile } from 'node:fs/promises';
import type pg from 'pg';
import { migrationQueries } from './queries.js';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);
const MIGRATION_LOCK = 7_265_001; // arbitrary constant so concurrent runners take turns

/** Applies numbered `.sql` files in order, once each, inside one transaction per file. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  let failure: Error | undefined;
  try {
    await client.query(migrationQueries.lock, [MIGRATION_LOCK]);
    await client.query(migrationQueries.createTable);
    const done = new Set(
      (await client.query<{ name: string }>(migrationQueries.listApplied)).rows.map((r) => r.name),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).toSorted();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
      try {
        await client.query(migrationQueries.begin);
        await client.query(sql);
        await client.query(migrationQueries.record, [file]);
        await client.query(migrationQueries.commit);
      } catch (error) {
        await client.query(migrationQueries.rollback).catch(() => undefined); // keep the original error
        throw error;
      }
      applied.push(file);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    await client.query(migrationQueries.unlock, [MIGRATION_LOCK]).catch(() => undefined);
    // After a failure the session state is uncertain: destroy the client instead of pooling it.
    client.release(failure);
  }
  return applied;
}
