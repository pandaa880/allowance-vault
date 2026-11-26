import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { LockTimeout } from '../../src/domain/errors.js';
import { migrate } from '../../src/infrastructure/pg/migrate.js';
import { PgLedgerRepository } from '../../src/infrastructure/pg/pg-ledger-repository.js';
import { migrationQueries, unitOfWork } from '../../src/infrastructure/pg/queries.js';

/**
 * Failure paths that are hard to provoke on a real server on demand: the pool and its client are
 * replaced by a script. Nothing here touches a database.
 */

const pgError = (code: string): Error => Object.assign(new Error(`pg ${code}`), { code });

interface Script {
  /** Called with each statement; return a result, or throw to fail it. */
  onQuery: (sql: string, call: number) => unknown;
}

function fakePool(script: Script) {
  const released: (Error | boolean | undefined)[] = [];
  const statements: { sql: string; params: unknown[] }[] = [];
  let call = 0;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return script.onQuery(sql, call++);
    },
    release: (error?: Error | boolean) => {
      released.push(error);
    },
  };
  return {
    // The fake implements only the two methods the code under test calls.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    pool: { connect: async () => client as unknown as PoolClient },
    released,
    statements,
  };
}

const work = async () => 'done';

describe('PgLedgerRepository retry and timeouts', () => {
  it('retries a deadlock and succeeds on the next attempt', async () => {
    let begins = 0;
    const { pool, released } = fakePool({
      onQuery: (sql) => {
        if (sql === unitOfWork.begin && ++begins === 1) throw pgError('40P01');
        return { rows: [], rowCount: 0 };
      },
    });
    const repo = new PgLedgerRepository(pool, { maxAttempts: 3 });
    await expect(repo.withTransaction(work)).resolves.toBe('done');
    expect(begins).toBe(2);
    expect(released).toHaveLength(2); // every attempt gives its client back
  });

  it('gives up on a lock timeout after maxAttempts, as LockTimeout', async () => {
    let begins = 0;
    const { pool } = fakePool({
      onQuery: (sql) => {
        if (sql === unitOfWork.begin) {
          begins++;
          throw pgError('55P03');
        }
        return { rows: [], rowCount: 0 };
      },
    });
    const repo = new PgLedgerRepository(pool, { maxAttempts: 2 });
    await expect(repo.withTransaction(work)).rejects.toBeInstanceOf(LockTimeout);
    expect(begins).toBe(2);
  });

  it.each(['23505', '22P02', '42P01'])('does not retry error %s', async (code) => {
    let begins = 0;
    const { pool } = fakePool({
      onQuery: (sql) => {
        if (sql === unitOfWork.begin) {
          begins++;
          throw pgError(code);
        }
        return { rows: [], rowCount: 0 };
      },
    });
    const repo = new PgLedgerRepository(pool, { maxAttempts: 3 });
    await expect(repo.withTransaction(work)).rejects.toThrow(`pg ${code}`);
    expect(begins).toBe(1);
  });

  it('sets the three timeouts right after BEGIN, from the options', async () => {
    const { pool, statements } = fakePool({ onQuery: () => ({ rows: [], rowCount: 0 }) });
    const repo = new PgLedgerRepository(pool, {
      lockTimeout: '1s',
      statementTimeout: '2s',
      idleInTransactionTimeout: '3s',
    });
    await repo.withTransaction(work);
    expect(statements.map((s) => s.sql)).toEqual([
      unitOfWork.begin,
      unitOfWork.setTimeouts,
      unitOfWork.commit,
    ]);
    expect(statements[1]?.params).toEqual(['1s', '2s', '3s']);
  });

  it('destroys a client whose ROLLBACK failed instead of pooling it', async () => {
    const { pool, released } = fakePool({
      onQuery: (sql) => {
        if (sql === unitOfWork.rollback) throw new Error('the rollback failed');
        return { rows: [], rowCount: 0 };
      },
    });
    const repo = new PgLedgerRepository(pool, { maxAttempts: 1 });
    await expect(
      repo.withTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it('returns a healthy client to the pool after a normal failure', async () => {
    const { pool, released } = fakePool({ onQuery: () => ({ rows: [], rowCount: 0 }) });
    const repo = new PgLedgerRepository(pool, { maxAttempts: 1 });
    await expect(
      repo.withTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(released).toEqual([undefined]);
  });
});

const happyQueries = (sql: string) => {
  if (sql === migrationQueries.listApplied) return { rows: [{ name: '0001_init.sql' }] };
  return { rows: [], rowCount: 0 };
};

describe('migrate() releases the connection safely', () => {
  it('returns the client normally when everything, including unlock, succeeds', async () => {
    const { pool, released } = fakePool({
      onQuery: (sql) =>
        sql === migrationQueries.unlock
          ? { rows: [{ pg_advisory_unlock: true }] }
          : happyQueries(sql),
    });
    await expect(migrate(pool)).resolves.toEqual([]);
    expect(released).toEqual([undefined]);
  });

  it('bounds the wait for the migration lock, then resets the timeout before releasing', async () => {
    const { pool, statements } = fakePool({
      onQuery: (sql) =>
        sql === migrationQueries.unlock
          ? { rows: [{ pg_advisory_unlock: true }] }
          : happyQueries(sql),
    });
    await migrate(pool, { lockWaitTimeout: '7s' });
    const sqls = statements.map((s) => s.sql);
    expect(sqls.slice(0, 2)).toEqual([
      migrationQueries.setSessionLockTimeout,
      migrationQueries.lock,
    ]);
    expect(statements[0]?.params).toEqual(['7s']);
    expect(sqls.slice(-2)).toEqual([migrationQueries.unlock, migrationQueries.resetLockTimeout]);
  });

  it('destroys the client when unlock reports the lock was not held', async () => {
    const { pool, released } = fakePool({
      onQuery: (sql) =>
        sql === migrationQueries.unlock
          ? { rows: [{ pg_advisory_unlock: false }] }
          : happyQueries(sql),
    });
    await migrate(pool);
    expect(released[0]).toBeInstanceOf(Error);
  });

  it('destroys the client when unlock itself fails, so the lock cannot stay held in the pool', async () => {
    const { pool, released } = fakePool({
      onQuery: (sql) => {
        if (sql === migrationQueries.unlock) throw new Error('connection reset');
        return happyQueries(sql);
      },
    });
    await migrate(pool);
    expect(released[0]).toBeInstanceOf(Error);
  });
});
