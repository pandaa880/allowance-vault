import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgPool, migrate } from '../../src/index.js';
import { migrationQueries } from '../../src/infrastructure/pg/queries.js';
import { databaseUrl, databaseUrlFor } from '../support/db.js';
import { countOf } from '../support/raw.js';
import { admin, inspect, MIGRATION_LOCK } from '../support/sql.js';

/**
 * The shared test database is already migrated after the first run, so on a warm container
 * `migrate()` does nothing and its real path is never exercised. This runs it from nothing, in a
 * throwaway database, every time. (A schema would not do: the migration creates its own.)
 */
const dbName = `migrate_test_${randomUUID().replaceAll('-', '')}`;

let adminPool: Pool;
let fresh: Pool;

beforeAll(async () => {
  adminPool = createPgPool(databaseUrl);
  await adminPool.query(admin.createDatabase(dbName));
  fresh = createPgPool(databaseUrlFor(dbName));
});
afterAll(async () => {
  await fresh.end();
  await adminPool.query(admin.dropDatabase(dbName));
  await adminPool.end();
});

describe('migrate() on an empty database', () => {
  it('applies every migration once, creating the ledger tables', async () => {
    expect(await migrate(fresh)).toEqual(['0001_init.sql']);
    const { rows } = await fresh.query<{ table_name: string }>(inspect.ledgerTables);
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
    const { rows } = await fresh.query<{ name: string }>(migrationQueries.listApplied);
    expect(rows.map((r) => r.name)).toEqual(['0001_init.sql']);
  });

  it('leaves the migration lock released, so the next run does not hang', async () => {
    const { rows } = await fresh.query<{ free: boolean }>(inspect.tryMigrationLock, [
      ...MIGRATION_LOCK,
    ]);
    expect(rows[0]?.free).toBe(true);
    await fresh.query(inspect.unlockAll);
  });

  it('removes the public right to create temporary tables', async () => {
    expect(await countOf(fresh, inspect.publicTempGrants, [])).toBe(0);
  });

  it('gives every trigger function a pinned search_path', async () => {
    const { rows } = await fresh.query<{ proname: string; proconfig: string[] | null }>(
      inspect.ledgerFunctions,
    );
    expect(rows.length).toBeGreaterThan(0);
    const unpinned = rows
      .filter((row) => !row.proconfig?.includes('search_path=pg_catalog, pg_temp'))
      .map((row) => row.proname);
    expect(unpinned).toEqual([]);
  });
});
