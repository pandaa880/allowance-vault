export class UnbalancedTransaction extends Error {
  override readonly name = "UnbalancedTransaction";
}

export class IdempotencyConflict extends Error {
  override readonly name = "IdempotencyConflict";
  constructor(readonly idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was already used with a different request`);
  }
}

export class OverCommitted extends Error {
  override readonly name = "OverCommitted";
  constructor(
    readonly scope: string,
    readonly unused: bigint,
    readonly requested: bigint,
  ) {
    super(`scope ${scope}: requested ${requested} but only ${unused} unused`);
  }
}

export class CurrencyMismatch extends Error {
  override readonly name = "CurrencyMismatch";
}
