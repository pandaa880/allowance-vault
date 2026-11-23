import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IdempotencyConflict,
  OverCommitted,
  UnbalancedTransaction,
} from '../../src/domain/errors.js';
import type { PostingRequest } from '../../src/domain/journal.js';
import { createPgLedger, createPgPool, migrate } from '../../src/index.js';

const url = process.env['DATABASE_URL'] ?? 'postgres://vault:vault@localhost:54329/vault_test';
const big = 2n ** 60n + 7n; // above Number.MAX_SAFE_INTEGER

let pool: pg.Pool;
let ledger: ReturnType<typeof createPgLedger>;

beforeAll(async () => {
  pool = createPgPool(url);
  await migrate(pool);
  ledger = createPgLedger(pool);
});
afterAll(async () => {
  await pool.end();
});

// Every test uses its own scope and keys, so tests never share rows and need no TRUNCATE.
const scopeOf = () => `period-${randomUUID()}`;
const rowCount = async (scope: string) =>
  Number(
    (
      await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM journal_entries e
         JOIN accounts a ON a.id = e.account_id WHERE a.scope = $1`,
        [scope],
      )
    ).rows[0]?.n,
  );

const reserveRequest = (scope: string, amount: bigint): PostingRequest => ({
  idempotencyKey: randomUUID(),
  kind: 'reserve',
  claimId: randomUUID(),
  currency: 'USDC',
  entries: [
    { account: { scope, kind: 'reserved' }, direction: 'debit', amount },
    { account: { scope, kind: 'source' }, direction: 'credit', amount },
  ],
});

describe('L2: every transaction balances, entries are append-only', () => {
  it('1a. use case rejects an unbalanced transaction and writes nothing', async () => {
    const scope = scopeOf();
    const bad = reserveRequest(scope, 100n);
    bad.entries[1] = { account: { scope, kind: 'source' }, direction: 'credit', amount: 99n };
    await expect(ledger.postTransaction(bad)).rejects.toBeInstanceOf(UnbalancedTransaction);
    expect(await rowCount(scope)).toBe(0);
  });

  it('1b. the database itself rejects an unbalanced commit (second line of defence)', async () => {
    const scope = scopeOf();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO accounts (id, scope, kind, currency) VALUES
         ($1, $2, 'reserved', 'USDC'), ($3, $2, 'source', 'USDC')`,
        [`${scope}/reserved`, scope, `${scope}/source`],
      );
      const txn = await client.query<{ id: string }>(
        `INSERT INTO transactions (id, kind, claim_id) VALUES (gen_random_uuid(), 'raw', NULL) RETURNING id`,
      );
      const txnId = String(txn.rows[0]?.id);
      await client.query(
        `INSERT INTO journal_entries (txn_id, account_id, direction, amount_base_units) VALUES
         ($1, $2, 'debit', 10), ($1, $3, 'credit', 9)`,
        [txnId, `${scope}/reserved`, `${scope}/source`],
      );
      await expect(client.query('COMMIT')).rejects.toThrow(/balance/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('2. UPDATE and DELETE on journal_entries are rejected', async () => {
    const scope = scopeOf();
    await ledger.postTransaction(reserveRequest(scope, 5n));
    await expect(pool.query('UPDATE journal_entries SET amount_base_units = 1')).rejects.toThrow(
      /append-only/i,
    );
    await expect(pool.query('DELETE FROM journal_entries')).rejects.toThrow(/append-only/i);
  });
});

describe('L3 and replay: idempotency keys', () => {
  it('3. same key and same request replays: zero new rows', async () => {
    const scope = scopeOf();
    const request = reserveRequest(scope, 5n);
    const first = await ledger.postTransaction(request);
    const second = await ledger.postTransaction(request);
    expect(first.status).toBe('created');
    expect(second.status).toBe('replayed');
    expect(second.txnId).toBe(first.txnId);
    expect(await rowCount(scope)).toBe(2);
  });

  it('4. same key with a different request is rejected (L3)', async () => {
    const scope = scopeOf();
    const request = reserveRequest(scope, 5n);
    await ledger.postTransaction(request);
    const changed = { ...reserveRequest(scope, 6n), idempotencyKey: request.idempotencyKey };
    await expect(ledger.postTransaction(changed)).rejects.toBeInstanceOf(IdempotencyConflict);
    expect(await rowCount(scope)).toBe(2);
  });

  it('4b. concurrent posts with one key create exactly one transaction', async () => {
    const scope = scopeOf();
    const request = reserveRequest(scope, 5n);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ledger.postTransaction(request)),
    );
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(await rowCount(scope)).toBe(2);
  });
});

describe('base units', () => {
  it('5. amounts round-trip as bigint above 2^53', async () => {
    const scope = scopeOf();
    await ledger.fundAllowance({
      idempotencyKey: randomUUID(),
      scope,
      currency: 'USDC',
      amount: big,
    });
    const summary = await ledger.periodSummary(scope);
    expect(summary.authorized).toBe(big);
    expect(summary.unused).toBe(big);
  });
});

describe('period cap: unused never goes negative', () => {
  it('6. reserve beyond authorized is rejected and writes nothing', async () => {
    const scope = scopeOf();
    await ledger.fundAllowance({
      idempotencyKey: randomUUID(),
      scope,
      currency: 'USDC',
      amount: 100n,
    });
    await ledger.reserveClaim({
      idempotencyKey: randomUUID(),
      scope,
      claimId: randomUUID(),
      currency: 'USDC',
      amount: 60n,
    });
    await expect(
      ledger.reserveClaim({
        idempotencyKey: randomUUID(),
        scope,
        claimId: randomUUID(),
        currency: 'USDC',
        amount: 41n,
      }),
    ).rejects.toBeInstanceOf(OverCommitted);
    const summary = await ledger.periodSummary(scope);
    expect(summary).toMatchObject({ authorized: 100n, reserved: 60n, unused: 40n });
  });

  it('6b. concurrent reserves cannot jointly over-commit', async () => {
    const scope = scopeOf();
    await ledger.fundAllowance({
      idempotencyKey: randomUUID(),
      scope,
      currency: 'USDC',
      amount: 100n,
    });
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        ledger.reserveClaim({
          idempotencyKey: randomUUID(),
          scope,
          claimId: randomUUID(),
          currency: 'USDC',
          amount: 30n,
        }),
      ),
    );
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(3);
    expect((await ledger.periodSummary(scope)).unused).toBe(10n);
  });
});
