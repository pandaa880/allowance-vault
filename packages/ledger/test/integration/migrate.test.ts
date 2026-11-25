import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgPool, migrate } from '../../src/index.js';
import { databaseUrl, databaseUrlFor } from './db.js';

/**
 * The shared test database is already migrated after the first run, so on a warm container
 * `migrate()` does nothing and its real path is never exercised. This runs it from nothing, in a
 * throwaway database, every time. (A schema would not do: the migration creates its own.)
 */
const dbName = `migrate_test_${randomUUID().replaceAll('-', '')}`;

let admin: Pool;
let fresh: Pool;

beforeAll(async () => {
  admin = createPgPool(databaseUrl);
  await admin.query(`CREATE DATABASE ${dbName}`);
  fresh = createPgPool(databaseUrlFor(dbName));
});
afterAll(async () => {
  await fresh.end();
  await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('migrate() on an empty database', () => {
  it('applies every migration once, creating the ledger tables', async () => {
    const applied = await migrate(fresh);
    expect(applied).toEqual(['0001_init.sql']);
    const { rows } = await fresh.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'ledger' ORDER BY 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'accounts',
      'idempotency_keys',
      'journal_entries',
      'scopes',
      'transactions',
    ]);
  });

  it('records what it applied, and a second run does nothing', async () => {
    expect(await migrate(fresh)).toEqual([]);
    const { rows } = await fresh.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toEqual(['0001_init.sql']);
  });

  it('leaves the migration lock released, so the next run does not hang', async () => {
    const { rows } = await fresh.query<{ free: boolean }>(
      'SELECT pg_try_advisory_lock(7265, 1) AS free',
    );
    expect(rows[0]?.free).toBe(true);
    await fresh.query('SELECT pg_advisory_unlock_all()');
  });

  it('removes the public right to create temporary tables', async () => {
    const { rows } = await fresh.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_database d, aclexplode(d.datacl) a
        WHERE d.datname = current_database() AND a.grantee = 0 AND a.privilege_type = 'TEMPORARY'`,
    );
    expect(rows[0]?.n).toBe('0');
  });

  it('gives every trigger function a pinned search_path', async () => {
    const { rows } = await fresh.query<{ proname: string; proconfig: string[] | null }>(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'ledger' ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(0);
    const unpinned = rows
      .filter((row) => !row.proconfig?.includes('search_path=pg_catalog, pg_temp'))
      .map((row) => row.proname);
    expect(unpinned).toEqual([]);
  });
});
