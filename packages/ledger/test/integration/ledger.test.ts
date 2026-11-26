import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CurrencyMismatch,
  IdempotencyConflict,
  InvalidRequest,
  LockTimeout,
  OverCommitted,
  UnbalancedTransaction,
} from '../../src/domain/errors.js';
import { MAX_AMOUNT, type EntryInput, type PostingRequest } from '../../src/domain/journal.js';
import { createPgLedger, createPgPool, migrate } from '../../src/index.js';
import { unitOfWork } from '../../src/infrastructure/pg/queries.js';
import { databaseUrl } from '../support/db.js';
import {
  countOf,
  holdScopeLock,
  inRawTransaction,
  insertAccount,
  insertEntries,
  insertScope,
  insertScopeWithAccounts,
  insertTxn,
} from '../support/raw.js';
import { attacks, inspect } from '../support/sql.js';

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
const rowCount = (scope: string) => countOf(pool, inspect.journalRowsInScope, [scope]);
const keyCount = (key: string) => countOf(pool, inspect.keyRows, [key]);

const fund = (scope: string, amount: bigint, idempotencyKey = randomUUID()) =>
  ledger.fundAllowance({ idempotencyKey, scope, currency: 'USDC', amount });
const reserve = (
  scope: string,
  amount: bigint,
  idempotencyKey = randomUUID(),
  claimId = randomUUID(),
) => ledger.reserveClaim({ idempotencyKey, scope, claimId, currency: 'USDC', amount });

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

const withEntries = (scope: string, amount: unknown) => [
  { account: { scope, kind: 'reserved' }, direction: 'debit', amount },
  { account: { scope, kind: 'source' }, direction: 'credit', amount },
];

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

describe('L2: every transaction balances', () => {
  it('1a. use case rejects an unbalanced transaction and writes nothing', async () => {
    const scope = scopeOf();
    const entries: EntryInput[] = [
      { account: { scope, kind: 'reserved' }, direction: 'debit', amount: 100n },
      { account: { scope, kind: 'source' }, direction: 'credit', amount: 99n },
    ];
    await expect(
      ledger.postTransaction({ ...reserveRequest(scope, 100n), entries }),
    ).rejects.toBeInstanceOf(UnbalancedTransaction);
    expect(await rowCount(scope)).toBe(0);
  });

  it('1b. the database rejects an unbalanced commit (second line of defence)', async () => {
    const scope = scopeOf();
    await expect(
      inRawTransaction(pool, async (client) => {
        await insertScopeWithAccounts(client, scope);
        await insertEntries(client, await insertTxn(client), scope, 10, 9);
      }),
    ).rejects.toThrow(/balance/i);
  });

  it('1c. the database rejects a single-entry transaction', async () => {
    const scope = scopeOf();
    await expect(
      inRawTransaction(pool, async (client) => {
        await insertScopeWithAccounts(client, scope);
        await insertEntries(client, await insertTxn(client), scope, 10);
      }),
    ).rejects.toThrow(/balance/i);
  });

  it('1c2. the database rejects a transaction with no entries', async () => {
    await expect(
      inRawTransaction(pool, async (client) => {
        await insertTxn(client);
      }),
    ).rejects.toThrow(/balance/i);
  });

  it('1d. entries cannot be added to a transaction that is already committed', async () => {
    const scope = await fundedScope();
    const { txnId } = await ledger.postTransaction(reserveRequest(scope, 5n));
    await expect(
      inRawTransaction(pool, async (client) => {
        await insertEntries(client, txnId, scope, 1, 1);
      }),
    ).rejects.toThrow(/closed/i);
    expect(await rowCount(scope)).toBe(FUND_ROWS + 2);
  });

  it('1e. an amount above the bigint range is a domain error, not a raw pg error', async () => {
    await expect(ledger.postTransaction(reserveRequest(scopeOf(), 2n ** 63n))).rejects.toThrow(
      /amounts must be between/,
    );
  });

  it('1f. a table of the same name in the session cannot fool the guards', async () => {
    const scope = await fundedScope();
    const { txnId } = await ledger.postTransaction(reserveRequest(scope, 5n));
    const client = await pool.connect();
    try {
      await client.query(unitOfWork.begin);
      // A temporary table is looked up before the real one unless the path says otherwise. The
      // guard names ledger.transactions, so this forged "created by me" row changes nothing.
      await client.query(attacks.shadowTransactions);
      await client.query(attacks.forgeCreatedByMe, [txnId]);
      await expect(insertEntries(client, txnId, scope, 1, 1)).rejects.toThrow(/closed/i);
    } finally {
      await client.query(unitOfWork.rollback).catch(() => undefined);
      client.release();
    }
  });

  it('1g. the database rejects an account whose currency differs from its scope', async () => {
    const scope = await fundedScope(); // a USDC scope
    await expect(
      insertAccount(pool, { id: `${scope}/released`, scope, kind: 'released', currency: 'INR' }),
    ).rejects.toThrow(/accounts_scope_currency_fk/);
  });
});

describe('L2: append-only', () => {
  it.each(attacks.mutations)('2. rejected: %s', async (statement) => {
    await fundedScope(); // make sure every table has a row to hit
    await expect(pool.query(statement)).rejects.toThrow(/append-only/i);
  });

  it.each(attacks.mutations)(
    '2b. still rejected with triggers switched off (replica mode): %s',
    async (statement) => {
      await fundedScope();
      const client = await pool.connect();
      try {
        await client.query(attacks.replicaModeOn);
        await expect(client.query(statement)).rejects.toThrow(/append-only/i);
      } finally {
        await client.query(attacks.replicaModeOff);
        client.release();
      }
    },
  );

  it('2c. an account id must match its scope and kind', async () => {
    const scope = scopeOf();
    await expect(
      inRawTransaction(pool, async (client) => {
        await insertScope(client, scope);
        await insertAccount(client, { id: 'wrong/reserved', scope, kind: 'reserved' });
      }),
    ).rejects.toThrow(/accounts_id_ck/);
  });
});

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
    const posting = ledger.postTransaction({ ...base(), entries });
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
    expect((await reserve(scope, 60n, key, claimId)).status).toBe('replayed');
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

  it('5b. the largest amount a bigint column holds round-trips exactly', async () => {
    const scope = scopeOf();
    await fund(scope, MAX_AMOUNT);
    expect((await ledger.periodSummary(scope)).authorized).toBe(MAX_AMOUNT);
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
    const reserveOne = () =>
      impatient.reserveClaim({
        idempotencyKey: randomUUID(),
        scope,
        claimId: randomUUID(),
        currency: 'USDC',
        amount: 1n,
      });
    const holder = await pool.connect();
    try {
      await holder.query(unitOfWork.begin);
      await holdScopeLock(holder, scope);
      await expect(reserveOne()).rejects.toBeInstanceOf(LockTimeout);
    } finally {
      await holder.query(unitOfWork.rollback);
      holder.release();
    }
    // Once the holder is gone the same kind of posting goes through.
    expect((await reserveOne()).status).toBe('created');
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
