import type { NewTransaction } from '../../application/ports.js';
import { accountId, touchedScopes, type AccountRef } from '../../domain/journal.js';

/** Pure builders for query parameters: no database, so they unit-test directly. */

const uniqueAccounts = (txn: NewTransaction): Map<string, AccountRef> =>
  new Map(txn.entries.map((e) => [accountId(e.account), e.account]));

/** Parallel arrays for `insertScopes`: scopes sorted, one currency each. */
export function scopeParams(txn: NewTransaction): [string[], string[]] {
  const scopes = touchedScopes(txn.entries);
  return [scopes, scopes.map(() => txn.currency)];
}

/** Parallel arrays for `insertAccounts`. Deduplicated and sorted by id (see the query). */
export function accountParams(txn: NewTransaction): [string[], string[], string[], string[]] {
  const sorted = [...uniqueAccounts(txn)].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [
    sorted.map(([id]) => id),
    sorted.map(([, ref]) => ref.scope),
    sorted.map(([, ref]) => ref.kind),
    sorted.map(() => txn.currency),
  ];
}

/** Parameters for `insertEntries`. Amounts stay strings so no value passes through a JS number. */
export function entryParams(txn: NewTransaction): [string, string[], string[], string[]] {
  return [
    txn.id,
    txn.entries.map((e) => accountId(e.account)),
    txn.entries.map((e) => e.direction),
    txn.entries.map((e) => e.amount.toString()),
  ];
}
