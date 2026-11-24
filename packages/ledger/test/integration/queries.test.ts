import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewTransaction } from '../../src/application/ports.js';
import { createPgPool, migrate } from '../../src/index.js';
import { accountParams, entryParams } from '../../src/infrastructure/pg/params.js';
import {
  ledgerQueries,
  migrationQueries,
  unitOfWork,
} from '../../src/infrastructure/pg/queries.js';

/** Each query is run on its own against real Postgres, so a typo or a wrong parameter order
 * fails here and not only through a use case. */

const url = process.env['DATABASE_URL'] ?? 'postgres://vault:vault@localhost:54329/vault_test';
const big = 2n ** 62n + 3n;

let pool: Pool;
beforeAll(async () => {
  pool = createPgPool(url);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
});

/** Runs `work` in one committed unit of work using the pinned begin/commit statements. */
async function inUnit<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(unitOfWork.begin);
    const result = await work(client);
    await client.query(unitOfWork.commit);
    return result;
  } catch (error) {
    await client.query(unitOfWork.rollback).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const newTxn = (scope: string, currency: 'USDC' | 'INR' = 'USDC'): NewTransaction => ({
  id: randomUUID(),
  kind: 'reserve',
  claimId: null,
  currency,
  entries: [
    { account: { scope, kind: 'reserved' }, direction: 'debit', amount: big },
    { account: { scope, kind: 'source' }, direction: 'credit', amount: big },
  ],
});

describe('unitOfWork', () => {
  it('begin starts READ COMMITTED even when the server default is stricter', async () => {
    const strict = new Pool({
      connectionString: url,
      options: '-c default_transaction_isolation=serializable',
    });
    const client = await strict.connect();
    try {
      await client.query(unitOfWork.begin);
      const { rows } = await client.query<{ level: string }>(
        "SELECT current_setting('transaction_isolation') AS level",
      );
      expect(rows[0]?.level).toBe('read committed');
      await client.query(unitOfWork.rollback);
    } finally {
      client.release();
      await strict.end();
    }
  });
});

describe('ledgerQueries', () => {
  it('lockScope runs and returns one row', async () => {
    const result = await inUnit((c) => c.query(ledgerQueries.lockScope, [randomUUID()]));
    expect(result.rowCount).toBe(1);
  });

  it('claimIdempotencyKey inserts once, then reports the key as taken', async () => {
    const key = randomUUID();
    const txn = newTxn(`scope-${randomUUID()}`);
    const claim = (c: PoolClient) =>
      c.query(ledgerQueries.claimIdempotencyKey, [key, 'hash-1', txn.id]);
    // The key references its transaction row, which is checked at commit, so insert it too.
    await inUnit(async (c) => {
      expect((await claim(c)).rowCount).toBe(1);
      await c.query(ledgerQueries.insertAccounts, accountParams(txn));
      await c.query(ledgerQueries.insertTransaction, [txn.id, txn.kind, txn.claimId]);
      await c.query(ledgerQueries.insertEntries, entryParams(txn));
    });
    await inUnit(async (c) => {
      expect((await claim(c)).rowCount).toBe(0);
      const found = await c.query<{ request_hash: string; txn_id: string }>(
        ledgerQueries.findIdempotencyKey,
        [key],
      );
      expect(found.rows[0]).toEqual({ request_hash: 'hash-1', txn_id: txn.id });
    });
  });

  it('findIdempotencyKey returns nothing for an unknown key', async () => {
    const found = await pool.query(ledgerQueries.findIdempotencyKey, [randomUUID()]);
    expect(found.rowCount).toBe(0);
  });

  it('insertAccounts is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const txn = newTxn(`scope-${randomUUID()}`);
    await inUnit(async (c) => {
      const first = await c.query(ledgerQueries.insertAccounts, accountParams(txn));
      const second = await c.query(ledgerQueries.insertAccounts, accountParams(txn));
      expect(first.rowCount).toBe(2);
      expect(second.rowCount).toBe(0);
    });
  });

  it('findMixedCurrency finds another currency in a scope, and only then', async () => {
    const scope = `scope-${randomUUID()}`;
    await inUnit((c) => c.query(ledgerQueries.insertAccounts, accountParams(newTxn(scope))));
    const mixed = await pool.query(ledgerQueries.findMixedCurrency, [[scope], 'INR']);
    const same = await pool.query(ledgerQueries.findMixedCurrency, [[scope], 'USDC']);
    expect(mixed.rowCount).toBeGreaterThan(0); // one row per mismatched account
    expect(same.rowCount).toBe(0);
  });

  it('insertTransaction and insertEntries write a balanced transaction that commits', async () => {
    const scope = `scope-${randomUUID()}`;
    const txn = newTxn(scope);
    await inUnit(async (c) => {
      await c.query(ledgerQueries.insertAccounts, accountParams(txn));
      await c.query(ledgerQueries.insertTransaction, [txn.id, txn.kind, txn.claimId]);
      const entries = await c.query(ledgerQueries.insertEntries, entryParams(txn));
      expect(entries.rowCount).toBe(2);
    });
  });

  it('scopeTotals returns sums as exact text above 2^53', async () => {
    const scope = `scope-${randomUUID()}`;
    const txn = newTxn(scope);
    await inUnit(async (c) => {
      await c.query(ledgerQueries.insertAccounts, accountParams(txn));
      await c.query(ledgerQueries.insertTransaction, [txn.id, txn.kind, txn.claimId]);
      await c.query(ledgerQueries.insertEntries, entryParams(txn));
    });
    const { rows } = await pool.query<{ kind: string; direction: string; total: string }>(
      ledgerQueries.scopeTotals,
      [scope],
    );
    expect(rows.toSorted((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: 'reserved', direction: 'debit', total: big.toString() },
      { kind: 'source', direction: 'credit', total: big.toString() },
    ]);
  });
});

describe('migrationQueries', () => {
  it('listApplied includes the initial migration after migrate()', async () => {
    const { rows } = await pool.query<{ name: string }>(migrationQueries.listApplied);
    expect(rows.map((r) => r.name)).toContain('0001_init.sql');
  });

  it('lock and unlock take and release the advisory lock', async () => {
    const client = await pool.connect();
    try {
      const n = 7_265_999;
      await client.query(migrationQueries.lock, [n]);
      const unlocked = await client.query<{ pg_advisory_unlock: boolean }>(
        migrationQueries.unlock,
        [n],
      );
      expect(unlocked.rows[0]?.pg_advisory_unlock).toBe(true);
    } finally {
      client.release();
    }
  });

  it('createTable is safe to run again', async () => {
    await expect(pool.query(migrationQueries.createTable)).resolves.toBeDefined();
  });
});
