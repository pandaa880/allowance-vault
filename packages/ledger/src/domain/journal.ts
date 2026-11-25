import { createHash } from 'node:crypto';
import { InvalidAmount, UnbalancedTransaction } from './errors.js';

/**
 * The lists below are the single source for these value sets. The SQL CHECK constraints repeat
 * them; `test/integration/schema-agreement.test.ts` fails if the two ever drift apart.
 */

/** Integer base units only: USDC 6 decimals, INR paise. Never a float. */
export const CURRENCIES = ['USDC', 'INR'] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * `source` is the system counter-account that makes flows balance. `unused` is not an
 * account: it is derived per scope (ADR 0012).
 */
export const ACCOUNT_KINDS = [
  'source',
  'authorized',
  'reserved',
  'released',
  'refunded',
  'fx_adjustment',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const DIRECTIONS = ['debit', 'credit'] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface AccountRef {
  /** A period or claim the account belongs to. */
  readonly scope: string;
  readonly kind: AccountKind;
}

export interface EntryInput {
  readonly account: AccountRef;
  readonly direction: Direction;
  readonly amount: bigint;
}

export interface PostingRequest {
  readonly idempotencyKey: string;
  readonly kind: string;
  readonly claimId: string | null;
  readonly currency: Currency;
  readonly entries: readonly EntryInput[];
}

export const accountId = ({ scope, kind }: AccountRef): string => `${scope}/${kind}`;

/** Distinct scopes the entries touch, sorted by name. */
export const touchedScopes = (entries: readonly EntryInput[]): string[] =>
  [...new Set(entries.map((e) => e.account.scope))].toSorted();

const sum = (entries: readonly EntryInput[], direction: Direction): bigint =>
  entries.filter((e) => e.direction === direction).reduce((total, e) => total + e.amount, 0n);

/** Largest value a Postgres bigint column holds. */
export const MAX_AMOUNT = 2n ** 63n - 1n;

/** L2: debits equal credits, at least two entries, every amount in 1..MAX_AMOUNT. */
export function assertBalanced(entries: readonly EntryInput[]): void {
  if (entries.length < 2)
    throw new UnbalancedTransaction('a transaction needs at least two entries');
  if (entries.some((e) => e.amount <= 0n || e.amount > MAX_AMOUNT))
    throw new InvalidAmount(`amounts must be between 1 and ${MAX_AMOUNT}`);
  if (sum(entries, 'debit') !== sum(entries, 'credit')) {
    throw new UnbalancedTransaction('debits do not equal credits');
  }
}

/**
 * Hash of everything except the key, so a replay with a changed request is detectable (L3).
 *
 * Security reasoning: if two different requests could share a hash, a stolen or reused key could
 * replay as "same request" and the second posting would be silently dropped. Two properties
 * prevent that. SHA-256 is collision resistant, and the encoding is unambiguous: JSON arrays
 * delimit every field, so ("ab", "c") can never encode like ("a", "bc"). The hash is
 * order-sensitive on purpose: a retry must repeat the request exactly.
 */
export function requestHash(request: PostingRequest): string {
  const canonical = JSON.stringify({
    kind: request.kind,
    claimId: request.claimId,
    currency: request.currency,
    entries: request.entries.map((e) => [
      e.account.scope,
      e.account.kind,
      e.direction,
      e.amount.toString(),
    ]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export interface PeriodSummary {
  readonly authorized: bigint;
  readonly reserved: bigint;
  readonly released: bigint;
  readonly refunded: bigint;
  readonly fxAdjustment: bigint;
  /** Derived: authorized minus everything that has left the pool. */
  readonly unused: bigint;
}

export interface Totals {
  debits: bigint;
  credits: bigint;
}

/** `authorized` is credit-normal (credits minus debits); the other kinds are debit-normal. */
export function summarize(totals: Partial<Record<AccountKind, Totals>>): PeriodSummary {
  const debitNet = (kind: AccountKind): bigint =>
    (totals[kind]?.debits ?? 0n) - (totals[kind]?.credits ?? 0n);
  const authorized = -debitNet('authorized');
  const reserved = debitNet('reserved');
  const released = debitNet('released');
  const refunded = debitNet('refunded');
  const fxAdjustment = debitNet('fx_adjustment');
  return {
    authorized,
    reserved,
    released,
    refunded,
    fxAdjustment,
    unused: authorized - reserved - released - refunded - fxAdjustment,
  };
}
