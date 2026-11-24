import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CurrencyMismatch,
  IdempotencyConflict,
  OverCommitted,
  UnbalancedTransaction,
} from '../../src/domain/errors.js';
import type { PostingRequest } from '../../src/domain/journal.js';
import { createPgLedger, createPgPool, migrate } from '../../src/index.js';

const url = process.env['DATABASE_URL'] ?? 'postgres://vault:vault@localhost:54329/vault_test';
const big = 2n ** 60n + 7n; // above Number.MAX_SAFE_INTEGER

let pool: Pool;
let ledger: ReturnType<typeof createPgLedger>;

beforeAll(async () => {
  pool = createPgPool(url);
  await migrate(pool);
  ledger = createPgLedger(pool);
});
afterAll(async () => {
  await pool.end();
});

// Every test uses its own scope and keys, so tests never share rows. The tables are append-only
// (TRUNCATE is blocked), so tests cannot clean up and must not need to.
const scopeOf = () => `period-${randomUUID()}`;

const count = async (sql: string, params: unknown[]): Promise<number> =>
  Number((await pool.query<{ n: string }>(sql, params)).rows[0]?.n);
const rowCount = (scope: string) =>
  count(
    `SELECT count(*) AS n FROM journal_entries e
       JOIN accounts a ON a.id = e.account_id WHERE a.scope = $1`,
    [scope],
  );
const keyCount = (key: string) =>
  count('SELECT count(*) AS n FROM idempotency_keys WHERE key = $1', [key]);

const fund = (scope: string, amount: bigint, idempotencyKey = randomUUID()) =>
  ledger.fundAllowance({ idempotencyKey, scope, currency: 'USDC', amount });
const reserve = (
  scope: string,
  amount: bigint,
  idempotencyKey = randomUUID(),
  claimId = randomUUID(),
) =>
  ledger.reserveClaim({
    idempotencyKey,
    scope,
    claimId,
    currency: 'USDC',
    amount,
  });

/** A fresh scope with room for the small reserves the plain posting tests make. */
const fundedScope = async (): Promise<string> => {
  const scope = scopeOf();
  await fund(scope, 1000n);
  return scope;
};
const FUND_ROWS = 2;

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

/** Runs raw SQL in one database transaction and resolves with the COMMIT outcome. */
async function rawTransaction(work: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await work(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const rawAccounts = (client: PoolClient, scope: string) =>
  client.query(
    `INSERT INTO accounts (id, scope, kind, currency) VALUES
       ($1, $2, 'reserved', 'USDC'), ($3, $2, 'source', 'USDC')`,
    [`${scope}/reserved`, scope, `${scope}/source`],
  );
const rawTxn = async (client: PoolClient): Promise<string> =>
  String(
    (
      await client.query<{ id: string }>(
        `INSERT INTO transactions (id, kind, claim_id) VALUES (gen_random_uuid(), 'raw', NULL) RETURNING id`,
      )
    ).rows[0]?.id,
  );
const rawEntries = (client: PoolClient, txnId: string, scope: string, ...amounts: number[]) =>
  client.query(
    `INSERT INTO journal_entries (txn_id, account_id, direction, amount_base_units)
     SELECT $1, $2 || '/' || kind, direction, amount
       FROM unnest($3::text[], $4::text[], $5::bigint[]) AS t(kind, direction, amount)`,
    [
      txnId,
      scope,
      amounts.map((_, i) => (i === 0 ? 'reserved' : 'source')),
      amounts.map((_, i) => (i === 0 ? 'debit' : 'credit')),
      amounts,
    ],
  );

describe('L2: every transaction balances', () => {
  it('1a. use case rejects an unbalanced transaction and writes nothing', async () => {
    const scope = scopeOf();
    const bad = reserveRequest(scope, 100n);
    bad.entries[1] = { account: { scope, kind: 'source' }, direction: 'credit', amount: 99n };
    await expect(ledger.postTransaction(bad)).rejects.toBeInstanceOf(UnbalancedTransaction);
    expect(await rowCount(scope)).toBe(0);
  });

  it('1b. the database rejects an unbalanced commit (second line of defence)', async () => {
    const scope = scopeOf();
    await expect(
      rawTransaction(async (client) => {
        await rawAccounts(client, scope);
        await rawEntries(client, await rawTxn(client), scope, 10, 9);
      }),
    ).rejects.toThrow(/balance/i);
  });

  it('1c. the database rejects a single-entry and a zero-entry transaction', async () => {
    const scope = scopeOf();
    await expect(
      rawTransaction(async (client) => {
        await rawAccounts(client, scope);
        await rawEntries(client, await rawTxn(client), scope, 10);
      }),
    ).rejects.toThrow(/balance/i);
    await expect(
      rawTransaction(async (client) => {
        await rawTxn(client);
      }),
    ).rejects.toThrow(/balance/i);
  });

  it('1d. entries cannot be added to a transaction that is already committed', async () => {
    const scope = await fundedScope();
    const { txnId } = await ledger.postTransaction(reserveRequest(scope, 5n));
    await expect(
      rawTransaction(async (client) => {
        await rawEntries(client, txnId, scope, 1, 1);
      }),
    ).rejects.toThrow(/closed/i);
    expect(await rowCount(scope)).toBe(FUND_ROWS + 2);
  });

  it('1e. an amount above the bigint range is a domain error, not a raw pg error', async () => {
    const tooBig = 2n ** 63n;
    await expect(ledger.postTransaction(reserveRequest(scopeOf(), tooBig))).rejects.toThrow(
      /amounts must be between/,
    );
  });
});

describe('L2: append-only', () => {
  it('2. UPDATE, DELETE and TRUNCATE are rejected on every table', async () => {
    await ledger.postTransaction(reserveRequest(await fundedScope(), 5n));
    const statements = [
      'UPDATE journal_entries SET amount_base_units = 1',
      'DELETE FROM journal_entries',
      'TRUNCATE journal_entries',
      'UPDATE transactions SET kind = kind',
      'DELETE FROM transactions',
      'TRUNCATE transactions CASCADE',
      "UPDATE idempotency_keys SET request_hash = 'x'",
      'DELETE FROM idempotency_keys',
      'TRUNCATE idempotency_keys',
      "UPDATE accounts SET kind = 'authorized' WHERE kind = 'reserved'",
      'DELETE FROM accounts',
      'TRUNCATE accounts CASCADE',
    ];
    for (const statement of statements) {
      await expect(
        pool.query(statement).catch((e: Error) => `${statement} -> ${e.message}`),
      ).resolves.toMatch(/append-only/i);
    }
  });

  it('2b. an account id must match its scope and kind', async () => {
    await expect(
      pool.query(
        `INSERT INTO accounts (id, scope, kind, currency) VALUES ('x/reserved', 'y', 'reserved', 'USDC')`,
      ),
    ).rejects.toThrow(/check/i);
  });
});

describe('L3 and replay: idempotency keys', () => {
  it('3. same key and same request replays: zero new rows', async () => {
    const scope = await fundedScope();
    const request = reserveRequest(scope, 5n);
    const first = await ledger.postTransaction(request);
    const second = await ledger.postTransaction(request);
    expect(first.status).toBe('created');
    expect(second.status).toBe('replayed');
    expect(second.txnId).toBe(first.txnId);
    expect(await rowCount(scope)).toBe(FUND_ROWS + 2);
  });

  it('4. same key with a different request is rejected (L3)', async () => {
    const scope = await fundedScope();
    const request = reserveRequest(scope, 5n);
    await ledger.postTransaction(request);
    const changed = { ...reserveRequest(scope, 6n), idempotencyKey: request.idempotencyKey };
    await expect(ledger.postTransaction(changed)).rejects.toBeInstanceOf(IdempotencyConflict);
    expect(await rowCount(scope)).toBe(FUND_ROWS + 2);
  });

  it('4b. concurrent posts with one key: one created, the rest replay the same transaction', async () => {
    const scope = await fundedScope();
    const request = reserveRequest(scope, 5n);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => ledger.postTransaction(request)),
    );
    const created = results.filter((r) => r.status === 'created');
    expect(created).toHaveLength(1);
    for (const result of results) expect(result.txnId).toBe(created[0]?.txnId);
    expect(await rowCount(scope)).toBe(FUND_ROWS + 2);
  });

  it('4c. replaying a successful reserve still works after the period is fully used', async () => {
    const scope = scopeOf();
    await fund(scope, 100n);
    const key = randomUUID();
    const claimId = randomUUID();
    await reserve(scope, 60n, key, claimId);
    await reserve(scope, 40n);
    expect((await ledger.periodSummary(scope)).unused).toBe(0n);
    const replay = await reserve(scope, 60n, key, claimId);
    expect(replay.status).toBe('replayed');
  });

  it('4d. a rejected over-commit leaves no key behind, so the same request can succeed later', async () => {
    const scope = scopeOf();
    await fund(scope, 100n);
    const key = randomUUID();
    const claimId = randomUUID();
    await expect(reserve(scope, 150n, key, claimId)).rejects.toBeInstanceOf(OverCommitted);
    expect(await keyCount(key)).toBe(0);
    await fund(scope, 100n);
    expect((await reserve(scope, 150n, key, claimId)).status).toBe('created');
  });
});

describe('base units', () => {
  it('5. amounts round-trip as bigint above 2^53', async () => {
    const scope = scopeOf();
    await fund(scope, big);
    const summary = await ledger.periodSummary(scope);
    expect(summary.authorized).toBe(big);
    expect(summary.unused).toBe(big);
  });
});

describe('period cap: unused never goes negative, on every posting path', () => {
  it('6. reserve beyond authorized is rejected and writes nothing', async () => {
    const scope = scopeOf();
    await fund(scope, 100n);
    await reserve(scope, 60n);
    await expect(reserve(scope, 41n)).rejects.toBeInstanceOf(OverCommitted);
    expect(await ledger.periodSummary(scope)).toMatchObject({
      authorized: 100n,
      reserved: 60n,
      unused: 40n,
    });
  });

  it('6b. concurrent reserves cannot jointly over-commit', async () => {
    const scope = scopeOf();
    await fund(scope, 100n);
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => reserve(scope, 30n)));
    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(3);
    const rejected = attempts.filter((a): a is PromiseRejectedResult => a.status === 'rejected');
    for (const attempt of rejected) expect(attempt.reason).toBeInstanceOf(OverCommitted);
    expect((await ledger.periodSummary(scope)).unused).toBe(10n);
  });

  it('6c. the generic postTransaction cannot bypass the cap', async () => {
    const scope = scopeOf();
    await fund(scope, 100n);
    await expect(ledger.postTransaction(reserveRequest(scope, 1000n))).rejects.toBeInstanceOf(
      OverCommitted,
    );
    expect(await rowCount(scope)).toBe(2); // only the fund entries
  });

  it('6d. lowering authorized below what is reserved is rejected', async () => {
    const scope = scopeOf();
    await fund(scope, 100n);
    await reserve(scope, 60n);
    const lower: PostingRequest = {
      idempotencyKey: randomUUID(),
      kind: 'lower-authorization',
      claimId: null,
      currency: 'USDC',
      entries: [
        { account: { scope, kind: 'authorized' }, direction: 'debit', amount: 50n },
        { account: { scope, kind: 'source' }, direction: 'credit', amount: 50n },
      ],
    };
    await expect(ledger.postTransaction(lower)).rejects.toBeInstanceOf(OverCommitted);
    expect((await ledger.periodSummary(scope)).authorized).toBe(100n);
  });

  it('6e. the cap holds even when the server default isolation is REPEATABLE READ', async () => {
    const strictPool = new Pool({
      connectionString: url,
      options: '-c default_transaction_isolation=repeatable\\ read',
    });
    try {
      const strictLedger = createPgLedger(strictPool);
      const scope = scopeOf();
      await strictLedger.fundAllowance({
        idempotencyKey: randomUUID(),
        scope,
        currency: 'USDC',
        amount: 100n,
      });
      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          strictLedger.reserveClaim({
            idempotencyKey: randomUUID(),
            scope,
            claimId: randomUUID(),
            currency: 'USDC',
            amount: 30n,
          }),
        ),
      );
      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(3);
      expect((await strictLedger.periodSummary(scope)).unused).toBe(10n);
    } finally {
      await strictPool.end();
    }
  });
});

describe('currency', () => {
  it('7. a scope never mixes currencies', async () => {
    const scope = scopeOf();
    await fund(scope, 100n);
    await expect(
      ledger.reserveClaim({
        idempotencyKey: randomUUID(),
        scope,
        claimId: randomUUID(),
        currency: 'INR',
        amount: 10n,
      }),
    ).rejects.toBeInstanceOf(CurrencyMismatch);
    expect(await rowCount(scope)).toBe(2);
  });
});
