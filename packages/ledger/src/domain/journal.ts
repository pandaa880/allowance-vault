import { createHash } from "node:crypto";
import { UnbalancedTransaction } from "./errors.js";

/** Integer base units only: USDC 6 decimals, INR paise. Never a float. */
export type Currency = "USDC" | "INR";

/**
 * `source` is the system counter-account that makes flows balance. `unused` is not an
 * account: it is derived per scope (ADR 0012).
 */
export type AccountKind = "source" | "authorized" | "reserved" | "released" | "refunded" | "fx_adjustment";

export type Direction = "debit" | "credit";

export interface AccountRef {
  /** A period or claim the account belongs to. */
  scope: string;
  kind: AccountKind;
}

export interface EntryInput {
  account: AccountRef;
  direction: Direction;
  amount: bigint;
}

export interface PostingRequest {
  idempotencyKey: string;
  kind: string;
  claimId: string | null;
  currency: Currency;
  entries: EntryInput[];
}

export const accountId = ({ scope, kind }: AccountRef): string => `${scope}/${kind}`;

const sum = (entries: EntryInput[], direction: Direction): bigint =>
  entries.filter((e) => e.direction === direction).reduce((total, e) => total + e.amount, 0n);

/** L2: debits equal credits, at least two entries, every amount positive. */
export function assertBalanced(entries: EntryInput[]): void {
  if (entries.length < 2) throw new UnbalancedTransaction("a transaction needs at least two entries");
  if (entries.some((e) => e.amount <= 0n)) throw new UnbalancedTransaction("amounts must be positive");
  if (sum(entries, "debit") !== sum(entries, "credit")) {
    throw new UnbalancedTransaction("debits do not equal credits");
  }
}

/** Hash of everything except the key, so a replay with a changed request is detectable (L3). */
export function requestHash(request: PostingRequest): string {
  const canonical = JSON.stringify({
    kind: request.kind,
    claimId: request.claimId,
    currency: request.currency,
    entries: request.entries.map((e) => [e.account.scope, e.account.kind, e.direction, e.amount.toString()]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export interface PeriodSummary {
  authorized: bigint;
  reserved: bigint;
  released: bigint;
  refunded: bigint;
  fxAdjustment: bigint;
  /** Derived: authorized minus everything that has left the pool. */
  unused: bigint;
}

export interface Totals {
  debits: bigint;
  credits: bigint;
}

/** `authorized` is credit-normal (credits minus debits); the other kinds are debit-normal. */
export function summarize(totals: Partial<Record<AccountKind, Totals>>): PeriodSummary {
  const debitNet = (kind: AccountKind): bigint => (totals[kind]?.debits ?? 0n) - (totals[kind]?.credits ?? 0n);
  const authorized = -debitNet("authorized");
  const reserved = debitNet("reserved");
  const released = debitNet("released");
  const refunded = debitNet("refunded");
  const fxAdjustment = debitNet("fx_adjustment");
  return {
    authorized,
    reserved,
    released,
    refunded,
    fxAdjustment,
    unused: authorized - reserved - released - refunded - fxAdjustment,
  };
}
