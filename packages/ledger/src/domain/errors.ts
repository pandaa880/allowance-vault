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
}

/** A request field fails its format rule (empty scope, oversized key, malformed claim id, ...). */
export class InvalidRequest extends Error {
  override readonly name = 'InvalidRequest';
}

/** Another writer held a lock past the timeout. Safe to retry: nothing was written. */
export class LockTimeout extends Error {
  override readonly name = 'LockTimeout';
}
