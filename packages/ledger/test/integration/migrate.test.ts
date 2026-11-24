import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgPool, migrate } from '../../src/index.js';

/**
 * The shared test database is already migrated after the first run, so on a warm container
 * `migrate()` does nothing and its real path is never exercised. This runs it from nothing,
 * into a throwaway schema, every time.
 */
const url = process.env['DATABASE_URL'] ?? 'postgres://vault:vault@localhost:54329/vault_test';
const schema = `migrate_test_${randomUUID().replaceAll('-', '')}`;

let admin: Pool;
let fresh: Pool;

beforeAll(async () => {
  admin = createPgPool(url);
  await admin.query(`CREATE SCHEMA ${schema}`);
  fresh = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
});
afterAll(async () => {
  await fresh.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

describe('migrate() on an empty schema', () => {
  it('applies every migration once, creating the ledger tables', async () => {
    const applied = await migrate(fresh);
    expect(applied).toEqual(['0001_init.sql']);
    const { rows } = await admin.query<{ table_name: string }>(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1',
      [schema],
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'accounts',
      'idempotency_keys',
      'journal_entries',
      'schema_migrations',
      'transactions',
    ]);
  });

  it('records what it applied, and a second run does nothing', async () => {
    expect(await migrate(fresh)).toEqual([]);
    const { rows } = await fresh.query<{ name: string }>('SELECT name FROM schema_migrations');
    expect(rows.map((r) => r.name)).toEqual(['0001_init.sql']);
  });
});
