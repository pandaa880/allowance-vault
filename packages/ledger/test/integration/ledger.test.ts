import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CurrencyMismatch,
  IdempotencyConflict,
  InvalidRequest,
  LockTimeout,
  OverCommitted,
  UnbalancedTransaction,
} from '../../src/domain/errors.js';
import type { EntryInput, PostingRequest } from '../../src/domain/journal.js';
import { createPgLedger, createPgPool, migrate } from '../../src/index.js';
import { databaseUrl } from './db.js';

const big = 2n ** 60n + 7n; // above Number.MAX_SAFE_INTEGER

let pool: Pool;
let ledger: ReturnType<typeof createPgLedger>;

beforeAll(async () => {
  pool = createPgPool(databaseUrl);
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
    `SELECT count(*) AS n FROM ledger.journal_entries e
       JOIN ledger.accounts a ON a.id = e.account_id WHERE a.scope = $1`,
    [scope],
  );
const keyCount = (key: string) =>
  count('SELECT count(*) AS n FROM ledger.idempotency_keys WHERE key = $1', [key]);

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

const rawScopeAndAccounts = async (client: PoolClient, scope: string) => {
  await client.query(`INSERT INTO ledger.scopes (scope, currency) VALUES ($1, 'USDC')`, [scope]);
  await client.query(
    `INSERT INTO ledger.accounts (id, scope, kind, currency) VALUES
       ($1, $2, 'reserved', 'USDC'), ($3, $2, 'source', 'USDC')`,
    [`${scope}/reserved`, scope, `${scope}/source`],
  );
};
const rawTxn = async (client: PoolClient): Promise<string> =>
  String(
    (
      await client.query<{ id: string }>(
        `INSERT INTO ledger.transactions (id, kind, claim_id) VALUES (gen_random_uuid(), 'raw', NULL) RETURNING id`,
      )
    ).rows[0]?.id,
  );
const rawEntries = (client: PoolClient, txnId: string, scope: string, ...amounts: number[]) =>
  client.query(
    `INSERT INTO ledger.journal_entries (txn_id, account_id, direction, amount_base_units)
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
    const entries: EntryInput[] = [
      { account: { scope, kind: 'reserved' }, direction: 'debit', amount: 100n },
      { account: { scope, kind: 'source' }, direction: 'credit', amount: 99n },
    ];
    await expect(ledger.postTransaction({ ...bad, entries })).rejects.toBeInstanceOf(
      UnbalancedTransaction,
    );
    expect(await rowCount(scope)).toBe(0);
  });

  it('1b. the database rejects an unbalanced commit (second line of defence)', async () => {
    const scope = scopeOf();
    await expect(
      rawTransaction(async (client) => {
        await rawScopeAndAccounts(client, scope);
        await rawEntries(client, await rawTxn(client), scope, 10, 9);
      }),
    ).rejects.toThrow(/balance/i);
  });

  it('1c. the database rejects a single-entry transaction', async () => {
    const scope = scopeOf();
    await expect(
      rawTransaction(async (client) => {
        await rawScopeAndAccounts(client, scope);
        await rawEntries(client, await rawTxn(client), scope, 10);
      }),
    ).rejects.toThrow(/balance/i);
  });

  it('1c2. the database rejects a transaction with no entries', async () => {
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

  it('1f. a table of the same name in the session cannot fool the guards', async () => {
    const scope = await fundedScope();
    const { txnId } = await ledger.postTransaction(reserveRequest(scope, 5n));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A temporary table is looked up before the real one unless the path says otherwise. The
      // guard names ledger.transactions, so this forged "created by me" row changes nothing.
      await client.query('CREATE TEMP TABLE transactions (id uuid, created_xid xid8)');
      await client.query('INSERT INTO pg_temp.transactions VALUES ($1, pg_current_xact_id())', [
        txnId,
      ]);
      await expect(rawEntries(client, txnId, scope, 1, 1)).rejects.toThrow(/closed/i);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('1g. the database rejects an account whose currency differs from its scope', async () => {
    const scope = await fundedScope(); // a USDC scope
    await expect(
      pool.query(
        `INSERT INTO ledger.accounts (id, scope, kind, currency) VALUES ($1, $2, 'released', 'INR')`,
        [`${scope}/released`, scope],
      ),
    ).rejects.toThrow(/accounts_scope_currency_fk/);
  });
});

describe('L2: append-only', () => {
  const statements = [
    'UPDATE ledger.journal_entries SET amount_base_units = 1',
    'DELETE FROM ledger.journal_entries',
    'TRUNCATE ledger.journal_entries',
    'UPDATE ledger.transactions SET kind = kind',
    'DELETE FROM ledger.transactions',
    'TRUNCATE ledger.transactions CASCADE',
    "UPDATE ledger.idempotency_keys SET request_hash = 'x'",
    'DELETE FROM ledger.idempotency_keys',
    'TRUNCATE ledger.idempotency_keys',
    "UPDATE ledger.accounts SET kind = 'authorized' WHERE kind = 'reserved'",
    'DELETE FROM ledger.accounts',
    'TRUNCATE ledger.accounts CASCADE',
    "UPDATE ledger.scopes SET currency = 'INR'",
    'DELETE FROM ledger.scopes',
    'TRUNCATE ledger.scopes CASCADE',
  ];

  it.each(statements)('2. rejected: %s', async (statement) => {
    await fundedScope(); // make sure every table has a row to hit
    await expect(pool.query(statement)).rejects.toThrow(/append-only/i);
  });

  it.each(statements)(
    '2b. still rejected with triggers switched off (replica mode): %s',
    async (statement) => {
      await fundedScope();
      const client = await pool.connect();
      try {
        await client.query('SET session_replication_role = replica');
        await expect(client.query(statement)).rejects.toThrow(/append-only/i);
      } finally {
        await client.query('RESET session_replication_role');
        client.release();
      }
    },
  );

  it('2c. an account id must match its scope and kind', async () => {
    const scope = scopeOf();
    await expect(
      rawTransaction(async (client) => {
        await client.query(`INSERT INTO ledger.scopes (scope, currency) VALUES ($1, 'USDC')`, [
          scope,
        ]);
        await client.query(
          `INSERT INTO ledger.accounts (id, scope, kind, currency) VALUES ('wrong/reserved', $1, 'reserved', 'USDC')`,
          [scope],
        );
      }),
    ).rejects.toThrow(/accounts_id_ck/);
  });
});

const withEntries = (scope: string, amount: unknown) => [
  { account: { scope, kind: 'reserved' }, direction: 'debit', amount },
  { account: { scope, kind: 'source' }, direction: 'credit', amount },
];

describe('request validation', () => {
  const base = (): Record<string, unknown> => ({
    idempotencyKey: randomUUID(),
    kind: 'reserve',
    claimId: randomUUID(),
    currency: 'USDC',
    entries: reserveRequest(scopeOf(), 5n).entries,
  });
  const cases: [string, Record<string, unknown>][] = [
    ['an empty idempotency key', { idempotencyKey: '' }],
    ['an oversized idempotency key', { idempotencyKey: 'k'.repeat(201) }],
    ['an unknown currency', { currency: 'EUR' }],
    ['a malformed claim id', { claimId: 'not-a-uuid' }],
    ['a bad transaction kind', { kind: 'Reserve It' }],
    ['an empty scope', { entries: withEntries('', 5n) }],
    ['a scope with a slash', { entries: withEntries('a/b', 5n) }],
    ['a number where a bigint belongs', { entries: withEntries(scopeOf(), 5) }],
  ];

  it.each(cases)('rejects %s and writes nothing', async (_name, change) => {
    await expect(ledger.postTransaction({ ...base(), ...change })).rejects.toBeInstanceOf(
      InvalidRequest,
    );
  });

  it('rejects something that is not an object at all', async () => {
    await expect(ledger.postTransaction(null)).rejects.toBeInstanceOf(InvalidRequest);
  });

  it('ignores later changes by the caller to the entries it passed', async () => {
    const scope = await fundedScope();
    const entries = [...reserveRequest(scope, 5n).entries];
    const request = { ...base(), entries };
    const posting = ledger.postTransaction(request);
    entries.pop(); // the caller mutates the array while the posting is in flight
    await expect(posting).resolves.toMatchObject({ status: 'created' });
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
    expect(await rowCount(scope)).toBe(FUND_ROWS); // only the fund entries
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
      connectionString: databaseUrl,
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

const across = (first: string, second: string): PostingRequest => ({
  idempotencyKey: randomUUID(),
  kind: 'move',
  claimId: null,
  currency: 'USDC',
  entries: [
    { account: { scope: first, kind: 'reserved' }, direction: 'debit', amount: 1n },
    { account: { scope: second, kind: 'source' }, direction: 'credit', amount: 1n },
  ],
});

describe('locking', () => {
  it('8. postings that touch the same two scopes in opposite orders never deadlock', async () => {
    const [a, b] = [scopeOf(), scopeOf()];
    await fund(a, 1000n);
    await fund(b, 1000n);
    const requests = Array.from({ length: 20 }, (_, i) => (i % 2 ? across(a, b) : across(b, a)));
    const results = await Promise.allSettled(requests.map((r) => ledger.postTransaction(r)));
    expect(results.map((r) => r.status)).toEqual(requests.map(() => 'fulfilled'));
  });

  it('9. a posting gives up with LockTimeout when another writer holds the scope too long', async () => {
    const scope = await fundedScope();
    const impatient = createPgLedger(pool, { lockTimeout: '200ms', maxAttempts: 1 });
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scope]);
      await expect(
        impatient.reserveClaim({
          idempotencyKey: randomUUID(),
          scope,
          claimId: randomUUID(),
          currency: 'USDC',
          amount: 1n,
        }),
      ).rejects.toBeInstanceOf(LockTimeout);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    // Once the holder is gone the same posting goes through.
    const retried = await impatient.reserveClaim({
      idempotencyKey: randomUUID(),
      scope,
      claimId: randomUUID(),
      currency: 'USDC',
      amount: 1n,
    });
    expect(retried.status).toBe('created');
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
    expect(await rowCount(scope)).toBe(FUND_ROWS);
  });
});
