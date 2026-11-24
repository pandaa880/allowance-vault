import type { NewTransaction } from '../../application/ports.js';
import { accountId, type AccountRef } from '../../domain/journal.js';

/** Pure builders for query parameters: no database, so they unit-test directly. */

const uniqueAccounts = (txn: NewTransaction): Map<string, AccountRef> =>
  new Map(txn.entries.map((e) => [accountId(e.account), e.account]));

/** Parallel arrays for `insertAccounts`. Deduplicated and sorted by id (see the query). */
export function accountParams(txn: NewTransaction): [string[], string[], string[], string[]] {
  const accounts = uniqueAccounts(txn);
  const ids = [...accounts.keys()].toSorted();
  const refs = ids.map((id) => accounts.get(id));
  return [
    ids,
    refs.map((a) => a?.scope ?? ''),
    refs.map((a) => a?.kind ?? ''),
    ids.map(() => txn.currency),
  ];
}

/** Distinct scopes the transaction touches, sorted. */
export function touchedScopes(txn: NewTransaction): string[] {
  return [...new Set([...uniqueAccounts(txn).values()].map((a) => a.scope))].toSorted();
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
