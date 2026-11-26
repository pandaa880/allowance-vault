import type { Currency } from './journal.js';

/**
 * Two kinds of failure, handled differently:
 * - A refusal (`PostRejection`): the request is well formed, but the ledger's current state
 *   forbids it. Nothing was written. Use cases return it as a value, so the caller has to decide
 *   (compensate, ask the family, alert) instead of retrying blindly.
 * - Everything else is thrown: a malformed request (`InvalidRequest`, `InvalidAmount`,
 *   `UnbalancedTransaction`) is a caller bug, and an infrastructure failure (`LockTimeout`, pg
 *   errors) is worth retrying. The classes below for refusals are only the signal that rolls the
 *   database transaction back; they never leave the use case.
 */
export type PostRejection =
  | { readonly kind: 'IdempotencyConflict'; readonly idempotencyKey: string }
  | { readonly kind: 'OverCommitted'; readonly scope: string; readonly unusedAfter: bigint }
  | { readonly kind: 'CurrencyMismatch'; readonly currency: Currency };

export class UnbalancedTransaction extends Error {
  override readonly name = 'UnbalancedTransaction';
}

export class IdempotencyConflict extends Error {
  override readonly name = 'IdempotencyConflict';
  constructor(readonly idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was already used with a different request`);
  }
}

/** The posting would leave `unused` below zero in `scope`, so it was rolled back. */
export class OverCommitted extends Error {
  override readonly name = 'OverCommitted';
  constructor(
    readonly scope: string,
    /** What `unused` would have been (negative). */
    readonly unusedAfter: bigint,
  ) {
    super(`scope ${scope}: posting would over-commit by ${-unusedAfter}`);
  }
}

/** An amount is not a positive integer that fits a Postgres bigint. */
export class InvalidAmount extends Error {
  override readonly name = 'InvalidAmount';
}

export class CurrencyMismatch extends Error {
  override readonly name = 'CurrencyMismatch';
  constructor(
    /** The currency of the refused transaction. */
    readonly currency: Currency,
    message: string,
  ) {
    super(message);
  }
}

/** A request field fails its format rule (empty scope, oversized key, malformed claim id, ...). */
export class InvalidRequest extends Error {
  override readonly name = 'InvalidRequest';
}

/** Another writer held a lock past the timeout. Safe to retry: nothing was written. */
export class LockTimeout extends Error {
  override readonly name = 'LockTimeout';
}
