import type { AccountKind, Currency, EntryInput, Totals } from '../domain/journal.js';

export interface NewTransaction {
  id: string;
  kind: string;
  claimId: string | null;
  currency: Currency;
  entries: EntryInput[];
}

export type KeyClaim =
  | { outcome: 'claimed' }
  | { outcome: 'exists'; requestHash: string; txnId: string };

/** Operations available inside one atomic unit of work. */
export interface LedgerTx {
  /** Serialises writers of one scope, so a read-check-write on it cannot interleave. */
  lockScope(scope: string): Promise<void>;
  /** Records the key, or reports the earlier use of it. Safe against concurrent callers. */
  claimIdempotencyKey(key: string, requestHash: string, txnId: string): Promise<KeyClaim>;
  insertTransaction(txn: NewTransaction): Promise<void>;
  scopeTotals(scope: string): Promise<Partial<Record<AccountKind, Totals>>>;
}

/** Port: the use cases know this interface, never a database driver. */
export interface LedgerRepository {
  /** Runs `work` atomically: all effects commit together, or none do. */
  withTransaction<T>(work: (tx: LedgerTx) => Promise<T>): Promise<T>;
}
