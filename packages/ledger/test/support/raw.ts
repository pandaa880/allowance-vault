import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ledgerQueries, unitOfWork } from '../../src/infrastructure/pg/queries.js';
import { CHECK_VIOLATION } from './sql.js';

/**
 * Raw writes that skip the use cases, so the database guards can be tested on their own. They
 * reuse the production statements with test parameters (an unbalanced amount, a closed txn id,
 * the wrong currency), so a guard is proven against the exact SQL the application sends.
 */

type Queryable = Pick<PoolClient, 'query'>;

/** Runs `work` in one database transaction and resolves with the COMMIT outcome. */
export async function inRawTransaction(
  pool: Pool,
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(unitOfWork.begin);
    await work(client);
    await client.query(unitOfWork.commit);
  } catch (error) {
    await client.query(unitOfWork.rollback).catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** True when the database accepts the statement; always rolls back. False only on a CHECK failure. */
export async function dbAccepts(pool: Pool, sql: string, params: unknown[]): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query(unitOfWork.begin);
    try {
      await client.query(sql, params);
      return true;
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === CHECK_VIOLATION) return false;
      throw error;
    }
  } finally {
    await client.query(unitOfWork.rollback);
    client.release();
  }
}

/** Reads a single `n` count column. */
export async function countOf(db: Queryable, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await db.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

export const insertScope = (db: Queryable, scope: string, currency = 'USDC') =>
  db.query(ledgerQueries.insertScopes, [[scope], [currency]]);

export const insertAccount = (
  db: Queryable,
  account: { id: string; scope: string; kind: string; currency?: string },
) =>
  db.query(ledgerQueries.insertAccounts, [
    [account.id],
    [account.scope],
    [account.kind],
    [account.currency ?? 'USDC'],
  ]);

/** A scope with its `reserved` and `source` accounts, in USDC. */
export async function insertScopeWithAccounts(db: Queryable, scope: string): Promise<void> {
  await insertScope(db, scope);
  await insertAccount(db, { id: `${scope}/reserved`, scope, kind: 'reserved' });
  await insertAccount(db, { id: `${scope}/source`, scope, kind: 'source' });
}

/** A bare transaction row; returns its id. */
export async function insertTxn(db: Queryable, claimId: string | null = null): Promise<string> {
  const id = randomUUID();
  await db.query(ledgerQueries.insertTransaction, [id, 'raw', claimId]);
  return id;
}

/** Entries on `<scope>/reserved` (first amount, debit) and `<scope>/source` (the rest, credit). */
export const insertEntries = (db: Queryable, txnId: string, scope: string, ...amounts: number[]) =>
  db.query(ledgerQueries.insertEntries, [
    txnId,
    amounts.map((_, i) => `${scope}/${i === 0 ? 'reserved' : 'source'}`),
    amounts.map((_, i) => (i === 0 ? 'debit' : 'credit')),
    amounts.map(String),
  ]);

/** Takes the scope's lock the way the ledger does, held until `db`'s transaction ends. */
export async function holdScopeLock(db: Queryable, scope: string): Promise<void> {
  const { rows } = await db.query<{ key: string }>(ledgerQueries.scopeLockKeys, [[scope]]);
  for (const { key } of rows) await db.query(ledgerQueries.lockKey, [key]);
}
