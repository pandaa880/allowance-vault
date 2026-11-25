import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_KINDS,
  CURRENCIES,
  DIRECTIONS,
  requestHash,
  summarize,
  type AccountKind,
  type Direction,
  type EntryInput,
  type PostingRequest,
  type Totals,
} from '../../src/domain/journal.js';

const NON_SOURCE = ACCOUNT_KINDS.filter((kind) => kind !== 'source');

const amountArb = fc.bigInt({ min: 1n, max: 10n ** 15n });

/** Sums entries into per-kind debit and credit totals, the way the database query does. */
function totalsOf(
  entries: readonly { kind: AccountKind; direction: Direction; amount: bigint }[],
): Partial<Record<AccountKind, Totals>> {
  const totals: Partial<Record<AccountKind, Totals>> = {};
  for (const { kind, direction, amount } of entries) {
    const entry = (totals[kind] ??= { debits: 0n, credits: 0n });
    if (direction === 'debit') entry.debits += amount;
    else entry.credits += amount;
  }
  return totals;
}

describe('summarize: sign of every account kind', () => {
  // [kind, direction posted, expected summary field and its value, expected unused]
  it.each([
    ['authorized', 'credit', 'authorized', 100n, 100n],
    ['reserved', 'debit', 'reserved', 30n, -30n],
    ['released', 'debit', 'released', 30n, -30n],
    ['refunded', 'debit', 'refunded', 30n, -30n],
    ['fx_adjustment', 'debit', 'fxAdjustment', 30n, -30n],
  ] as const)('%s %s lands in %s', (kind, direction, field, value, unused) => {
    const summary = summarize(totalsOf([{ kind, direction, amount: value }]));
    expect(summary[field]).toBe(value);
    expect(summary.unused).toBe(unused);
  });

  it.each(['reserved', 'released', 'refunded', 'fx_adjustment'] as const)(
    'a credit to %s gives cap back (reverses a debit)',
    (kind) => {
      const summary = summarize(
        totalsOf([
          { kind: 'authorized', direction: 'credit', amount: 100n },
          { kind, direction: 'debit', amount: 60n },
          { kind, direction: 'credit', amount: 20n },
        ]),
      );
      expect(summary.unused).toBe(60n);
    },
  );

  it('ignores the source account', () => {
    const summary = summarize(totalsOf([{ kind: 'source', direction: 'debit', amount: 50n }]));
    expect(summary.unused).toBe(0n);
  });
});

describe('summarize: conservation (property)', () => {
  it('for any balanced transaction set, unused equals the net the system source has paid out', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom(...NON_SOURCE),
            direction: fc.constantFrom(...DIRECTIONS),
            amount: amountArb,
          }),
          { maxLength: 30 },
        ),
        (entries) => {
          // Balance the set with source entries, exactly as every real posting does.
          const net = entries.reduce(
            (sum, e) => sum + (e.direction === 'debit' ? e.amount : -e.amount),
            0n,
          );
          const balanced = [
            ...entries,
            ...(net > 0n
              ? [{ kind: 'source' as const, direction: 'credit' as const, amount: net }]
              : []),
            ...(net < 0n
              ? [{ kind: 'source' as const, direction: 'debit' as const, amount: -net }]
              : []),
          ];
          const totals = totalsOf(balanced);
          const sourceNetDebit = (totals.source?.debits ?? 0n) - (totals.source?.credits ?? 0n);
          // Every unit leaving `unused` shows up as exactly one unit of source credit.
          expect(summarize(totals).unused).toBe(sourceNetDebit);
        },
      ),
    );
  });
});

const withFirstEntry = (
  r: PostingRequest,
  change: (e: EntryInput) => EntryInput,
): PostingRequest => ({
  ...r,
  entries: r.entries.map((e, i) => (i === 0 ? change(e) : e)),
});
const otherKind = (kind: AccountKind): AccountKind =>
  ACCOUNT_KINDS[(ACCOUNT_KINDS.indexOf(kind) + 1) % ACCOUNT_KINDS.length] ?? 'source';

describe('requestHash: every field of the request is covered (property)', () => {
  const entryArb: fc.Arbitrary<EntryInput> = fc.record({
    account: fc.record({
      scope: fc.string({ minLength: 1, maxLength: 8 }),
      kind: fc.constantFrom(...ACCOUNT_KINDS),
    }),
    direction: fc.constantFrom(...DIRECTIONS),
    amount: amountArb,
  });
  const requestArb: fc.Arbitrary<PostingRequest> = fc.record({
    idempotencyKey: fc.string({ minLength: 1 }),
    kind: fc.stringMatching(/^[a-z][a-z_-]{0,10}$/),
    claimId: fc.option(fc.uuid(), { nil: null }),
    currency: fc.constantFrom(...CURRENCIES),
    entries: fc.array(entryArb, { minLength: 1, maxLength: 4 }),
  });

  /** Each change touches exactly one hashed field. */
  const changes: [string, (r: PostingRequest) => PostingRequest][] = [
    ['kind', (r) => ({ ...r, kind: `${r.kind}x` })],
    ['claimId', (r) => ({ ...r, claimId: r.claimId === null ? 'x' : null })],
    ['currency', (r) => ({ ...r, currency: r.currency === 'USDC' ? 'INR' : 'USDC' })],
    [
      'scope',
      (r) =>
        withFirstEntry(r, (e) => ({
          ...e,
          account: { ...e.account, scope: `${e.account.scope}x` },
        })),
    ],
    [
      'account kind',
      (r) =>
        withFirstEntry(r, (e) => ({
          ...e,
          account: { ...e.account, kind: otherKind(e.account.kind) },
        })),
    ],
    [
      'direction',
      (r) =>
        withFirstEntry(r, (e) => ({
          ...e,
          direction: e.direction === 'debit' ? 'credit' : 'debit',
        })),
    ],
    ['amount', (r) => withFirstEntry(r, (e) => ({ ...e, amount: e.amount + 1n }))],
    ['an extra entry', (r) => ({ ...r, entries: [...r.entries, ...r.entries.slice(0, 1)] })],
  ];

  it.each(changes)('changing the %s changes the hash', (_field, change) => {
    fc.assert(
      fc.property(requestArb, (request) => {
        expect(requestHash(change(request))).not.toBe(requestHash(request));
      }),
    );
  });

  it('changing only the idempotency key does not change the hash', () => {
    fc.assert(
      fc.property(requestArb, fc.string({ minLength: 1 }), (request, key) => {
        expect(requestHash({ ...request, idempotencyKey: key })).toBe(requestHash(request));
      }),
    );
  });
});
