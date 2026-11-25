import { randomUUID } from 'node:crypto';
import * as fc from 'fast-check';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  parsePostingRequest,
  SCOPE_PATTERN,
  TXN_KIND_PATTERN,
} from '../../src/application/schemas.js';
import { ACCOUNT_KINDS, CURRENCIES, DIRECTIONS } from '../../src/domain/journal.js';
import { createPgPool, migrate } from '../../src/index.js';
import { databaseUrl } from './db.js';

/**
 * The TypeScript rules (what `parsePostingRequest` accepts) and the SQL CHECK constraints are
 * written twice on purpose: the first gives callers a clear error, the second is the last line of
 * defence. These tests fail if the two ever disagree.
 */

let pool: Pool;
beforeAll(async () => {
  pool = createPgPool(databaseUrl);
  await migrate(pool);
});
afterAll(async () => {
  await pool.end();
});

/** The quoted words in a constraint definition, e.g. CHECK (kind IN ('a', 'b')) gives a and b. */
async function constraintWords(name: string): Promise<string[]> {
  const { rows } = await pool.query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'ledger' AND c.conname = $1`,
    [name],
  );
  return [...(rows[0]?.def ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
}

describe('value lists agree with the SQL CHECK constraints', () => {
  it.each([
    ['accounts_kind_ck', ACCOUNT_KINDS],
    ['scopes_currency_ck', CURRENCIES],
    ['journal_entries_direction_ck', DIRECTIONS],
  ] as const)('%s lists exactly the TypeScript values', async (name, values) => {
    expect((await constraintWords(name)).toSorted()).toEqual([...values].toSorted());
  });
});

describe('format rules agree with the SQL CHECK constraints', () => {
  const scopeSample = fc.oneof(
    fc.stringMatching(/^[A-Za-z0-9._:-]{0,130}$/),
    fc.string({ maxLength: 12 }),
    fc.constantFrom('', 'a/b', 'a b', 'x'.repeat(128), 'x'.repeat(129), 'é'),
  );

  it('scope: TypeScript accepts a string exactly when the database does', async () => {
    await fc.assert(
      fc.asyncProperty(scopeSample, async (scope) => {
        const sql = `INSERT INTO ledger.scopes (scope, currency) VALUES ($1, 'USDC')`;
        const asDb = await dbAcceptsOne(sql, [scope]);
        expect(SCOPE_PATTERN.test(scope)).toBe(asDb);
      }),
      { numRuns: 60 },
    );
  });

  it('transaction kind: TypeScript accepts a string exactly when the database does', async () => {
    const kindSample = fc.oneof(
      fc.stringMatching(/^[a-z_-]{0,42}$/),
      fc.string({ maxLength: 12 }),
      fc.constantFrom('', 'reserve', 'Reserve', 'a'.repeat(40), 'a'.repeat(41), '-x', '1x'),
    );
    await fc.assert(
      fc.asyncProperty(kindSample, async (kind) => {
        const sql = 'INSERT INTO ledger.transactions (id, kind) VALUES (gen_random_uuid(), $1)';
        expect(TXN_KIND_PATTERN.test(kind)).toBe(await dbAcceptsOne(sql, [kind]));
      }),
      { numRuns: 60 },
    );
  });

  it.each([
    ['empty', '', false],
    ['one byte', 'k', true],
    ['200 bytes', 'k'.repeat(200), true],
    ['201 bytes', 'k'.repeat(201), false],
    ['200 bytes of two-byte characters', 'é'.repeat(100), true],
    ['202 bytes of two-byte characters', 'é'.repeat(101), false],
  ])('idempotency key, %s: TypeScript and the database agree', async (_name, key, expected) => {
    const request = {
      idempotencyKey: key,
      kind: 'reserve',
      claimId: null,
      currency: 'USDC',
      entries: [],
    };
    const tsAccepts = (() => {
      try {
        parsePostingRequest(request);
        return true;
      } catch {
        return false;
      }
    })();
    const dbOk = await dbAcceptsOne(
      `INSERT INTO ledger.idempotency_keys (key, request_hash, txn_id) VALUES ($1, '${'a'.repeat(64)}', gen_random_uuid())`,
      [key],
    );
    expect([tsAccepts, dbOk]).toEqual([expected, expected]);
  });

  it('claim id: every uuid TypeScript accepts is a uuid the database accepts', async () => {
    const id = randomUUID();
    expect(
      await dbAcceptsOne(
        'INSERT INTO ledger.transactions (id, kind, claim_id) VALUES (gen_random_uuid(), $1, $2)',
        ['reserve', id],
      ),
    ).toBe(true);
  });
});

/** Like `dbAccepts`, for a single statement with parameters. */
async function dbAcceptsOne(sql: string, params: unknown[]): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(sql, params);
      return true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23514'
      ) {
        return false; // check_violation
      }
      throw error;
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}
