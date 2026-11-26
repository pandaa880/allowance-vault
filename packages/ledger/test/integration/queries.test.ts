import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewTransaction } from '../../src/application/ports.js';
import { createPgPool, migrate } from '../../src/index.js';
import { accountParams, entryParams, scopeParams } from '../../src/infrastructure/pg/params.js';
import {
  ledgerQueries,
  migrationQueries,
  unitOfWork,
} from '../../src/infrastructure/pg/queries.js';
import { databaseUrl } from '../support/db.js';
import { inspect, VALID_HASH } from '../support/sql.js';

/** Each query is run on its own against real Postgres, so a typo or a wrong parameter order
 * fails here and not only through a use case. */

const big = 2n ** 62n + 3n;

let pool: Pool;
beforeAll(async () => {
  pool = createPgPool(databaseUrl);
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

/** Scopes, accounts, the transaction row and its entries, in the order the adapter writes them. */
async function writeTxn(client: PoolClient, txn: NewTransaction): Promise<void> {
  await client.query(ledgerQueries.insertScopes, scopeParams(txn));
  await client.query(ledgerQueries.insertAccounts, accountParams(txn));
  await client.query(ledgerQueries.insertTransaction, [txn.id, txn.kind, txn.claimId]);
  await client.query(ledgerQueries.insertEntries, entryParams(txn));
}

const find = (scopes: string[], currency: string) =>
  pool.query(ledgerQueries.findMixedCurrency, [scopes, currency]);
const lockKeys = async (scopes: string[]): Promise<string[]> => {
  const { rows } = await pool.query<{ key: string }>(ledgerQueries.scopeLockKeys, [scopes]);
  return rows.map((r) => r.key);
};

const read = (client: PoolClient) =>
  client.query<{ lock: string; statement: string; idle: string }>(inspect.timeouts);

describe('unitOfWork', () => {
  it('unitOfWork.begin starts READ COMMITTED even when the server default is stricter', async () => {
    const strict = new Pool({
      connectionString: databaseUrl,
      options: '-c default_transaction_isolation=serializable',
    });
    const client = await strict.connect();
    try {
      await client.query(unitOfWork.begin);
      const { rows } = await client.query<{ level: string }>(inspect.isolation);
      expect(rows[0]?.level).toBe('read committed');
      await client.query(unitOfWork.rollback);
    } finally {
      client.release();
      await strict.end();
    }
  });

  it('setTimeouts applies for this transaction only', async () => {
    const client = await pool.connect();
    try {
      await client.query(unitOfWork.begin);
      await client.query(unitOfWork.setTimeouts, ['1s', '2s', '3s']);
      expect((await read(client)).rows[0]).toEqual({ lock: '1s', statement: '2s', idle: '3s' });
      await client.query(unitOfWork.commit);
      // After the transaction the connection is back to its defaults (nothing leaks into the pool).
      expect((await read(client)).rows[0]).toEqual({ lock: '0', statement: '0', idle: '0' });
    } finally {
      client.release();
    }
  });
});

describe('ledgerQueries', () => {
  it('scopeLockKeys returns distinct keys, ascending, whatever order the scopes come in', async () => {
    const scopes = ['b', 'a', 'c', 'a'];
    const keys = await lockKeys(scopes);
    expect(keys).toHaveLength(3);
    expect(keys.map(BigInt)).toEqual(
      keys.map(BigInt).toSorted((x, y) => (x < y ? -1 : x > y ? 1 : 0)),
    );
    expect(await lockKeys(scopes.toReversed())).toEqual(keys);
  });

  it('lockKey holds the lock until the unit of work ends, then releases it', async () => {
    const [key] = await lockKeys([randomUUID()]);
    const probe = await pool.connect();
    // Asks, from another connection, whether the lock is free right now.
    const lockIsFree = async (): Promise<boolean | undefined> => {
      await probe.query(unitOfWork.begin);
      try {
        const { rows } = await probe.query<{ free: boolean }>(inspect.tryXactLock, [key]);
        return rows[0]?.free;
      } finally {
        await probe.query(unitOfWork.rollback);
      }
    };
    try {
      await inUnit(async (c) => {
        await c.query(ledgerQueries.lockKey, [key]);
        expect(await lockIsFree()).toBe(false); // held while the unit is open
      });
      expect(await lockIsFree()).toBe(true); // released at commit
    } finally {
      probe.release();
    }
  });

  it('claimIdempotencyKey inserts once, then reports the key as taken', async () => {
    const key = randomUUID();
    const txn = newTxn(`scope-${randomUUID()}`);
    const claim = (c: PoolClient) =>
      c.query(ledgerQueries.claimIdempotencyKey, [key, VALID_HASH, txn.id]);
    // The key references its transaction row, which is checked at commit, so write it too.
    await inUnit(async (c) => {
      expect((await claim(c)).rowCount).toBe(1);
      await writeTxn(c, txn);
    });
    await inUnit(async (c) => {
      expect((await claim(c)).rowCount).toBe(0);
      const found = await c.query(ledgerQueries.findIdempotencyKey, [key]);
      expect(found.rows[0]).toEqual({ request_hash: VALID_HASH, txn_id: txn.id });
    });
  });

  it('findIdempotencyKey returns nothing for an unknown key', async () => {
    const found = await pool.query(ledgerQueries.findIdempotencyKey, [randomUUID()]);
    expect(found.rowCount).toBe(0);
  });

  it('insertScopes is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const txn = newTxn(`scope-${randomUUID()}`);
    await inUnit(async (c) => {
      expect((await c.query(ledgerQueries.insertScopes, scopeParams(txn))).rowCount).toBe(1);
      expect((await c.query(ledgerQueries.insertScopes, scopeParams(txn))).rowCount).toBe(0);
    });
  });

  it('insertAccounts is idempotent (ON CONFLICT DO NOTHING)', async () => {
    const txn = newTxn(`scope-${randomUUID()}`);
    await inUnit(async (c) => {
      await c.query(ledgerQueries.insertScopes, scopeParams(txn));
      expect((await c.query(ledgerQueries.insertAccounts, accountParams(txn))).rowCount).toBe(2);
      expect((await c.query(ledgerQueries.insertAccounts, accountParams(txn))).rowCount).toBe(0);
    });
  });

  it('findMixedCurrency finds another currency in a scope, and only then', async () => {
    const usdcScope = `scope-${randomUUID()}`;
    const inrScope = `scope-${randomUUID()}`;
    await inUnit(async (c) => {
      await c.query(ledgerQueries.insertScopes, scopeParams(newTxn(usdcScope)));
      await c.query(ledgerQueries.insertScopes, scopeParams(newTxn(inrScope, 'INR')));
    });
    expect((await find([usdcScope], 'INR')).rowCount).toBe(1);
    expect((await find([usdcScope], 'USDC')).rowCount).toBe(0);
    // The scope filter matters: an INR scope elsewhere must not count against a USDC scope.
    expect((await find([usdcScope, inrScope], 'USDC')).rowCount).toBe(1);
  });

  it('insertTransaction and insertEntries write a balanced transaction that commits', async () => {
    const txn = newTxn(`scope-${randomUUID()}`);
    await inUnit(async (c) => {
      await c.query(ledgerQueries.insertScopes, scopeParams(txn));
      await c.query(ledgerQueries.insertAccounts, accountParams(txn));
      await c.query(ledgerQueries.insertTransaction, [txn.id, txn.kind, txn.claimId]);
      const entries = await c.query(ledgerQueries.insertEntries, entryParams(txn));
      expect(entries.rowCount).toBe(2);
    });
  });

  it('scopeTotals returns sums as exact text above 2^53', async () => {
    const scope = `scope-${randomUUID()}`;
    await inUnit((c) => writeTxn(c, newTxn(scope)));
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

  it('lock and unlock take and release the two-int advisory lock', async () => {
    const client = await pool.connect();
    try {
      const args = [7265, 999];
      await client.query(migrationQueries.lock, args);
      const unlocked = await client.query<{ pg_advisory_unlock: boolean }>(
        migrationQueries.unlock,
        args,
      );
      expect(unlocked.rows[0]?.pg_advisory_unlock).toBe(true);
    } finally {
      client.release();
    }
  });

  it('setLockTimeout applies inside the migration transaction only', async () => {
    const client = await pool.connect();
    try {
      await client.query(migrationQueries.begin);
      await client.query(migrationQueries.setLockTimeout, ['3s']);
      const inside = await client.query<{ t: string }>(inspect.lockTimeout);
      await client.query(migrationQueries.commit);
      const after = await client.query<{ t: string }>(inspect.lockTimeout);
      expect([inside.rows[0]?.t, after.rows[0]?.t]).toEqual(['3s', '0']);
    } finally {
      client.release();
    }
  });

  it('createTable is safe to run again', async () => {
    await expect(pool.query(migrationQueries.createTable)).resolves.toBeDefined();
  });
});
