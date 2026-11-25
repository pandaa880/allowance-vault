import type { AccountKind, Currency, EntryInput, Totals } from '../domain/journal.js';

export interface NewTransaction {
  readonly id: string;
  readonly kind: string;
  readonly claimId: string | null;
  readonly currency: Currency;
  readonly entries: readonly EntryInput[];
}

export type KeyClaim =
  | { readonly outcome: 'claimed' }
  | { readonly outcome: 'exists'; readonly requestHash: string; readonly txnId: string };

/** Operations available inside one atomic unit of work. */
export interface LedgerTx {
  /**
   * Serialises writers of these scopes, so a read-check-write on them cannot interleave. The
   * implementation takes the locks in one fixed order, whatever order `scopes` arrives in.
   */
  lockScopes(scopes: readonly string[]): Promise<void>;
  /** Records the key, or reports the earlier use of it. Safe against concurrent callers. */
  claimIdempotencyKey(key: string, requestHash: string, txnId: string): Promise<KeyClaim>;
  /**
   * Writes the transaction and its entries. Rule it must enforce: a scope never mixes
   * currencies. Throws `CurrencyMismatch` when a touched scope already holds another currency.
   */
  insertTransaction(txn: NewTransaction): Promise<void>;
  scopeTotals(scope: string): Promise<Partial<Record<AccountKind, Totals>>>;
}

/** Port: the use cases know this interface, never a database driver. */
export interface LedgerRepository {
  /**
   * Runs `work` atomically: all effects commit together, or none do. The implementation may run
   * `work` again after a transient failure (deadlock, lock timeout), so `work` must be safe to
   * repeat: it may only touch the database through the `LedgerTx` it is given.
   */
  withTransaction<T>(work: (tx: LedgerTx) => Promise<T>): Promise<T>;
}
