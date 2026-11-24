import { describe, expect, it } from 'vitest';
import type { NewTransaction } from '../../src/application/ports.js';
import { accountParams, entryParams, touchedScopes } from '../../src/infrastructure/pg/params.js';

const big = 2n ** 62n + 3n; // above Number.MAX_SAFE_INTEGER

const txn = (overrides: Partial<NewTransaction> = {}): NewTransaction => ({
  id: 'txn-1',
  kind: 'reserve',
  claimId: 'claim-1',
  currency: 'USDC',
  entries: [
    { account: { scope: 'b', kind: 'source' }, direction: 'credit', amount: big },
    { account: { scope: 'b', kind: 'reserved' }, direction: 'debit', amount: big },
  ],
  ...overrides,
});

describe('accountParams', () => {
  it('returns parallel arrays sorted by account id', () => {
    expect(accountParams(txn())).toEqual([
      ['b/reserved', 'b/source'],
      ['b', 'b'],
      ['reserved', 'source'],
      ['USDC', 'USDC'],
    ]);
  });

  it('deduplicates an account that appears in several entries', () => {
    const entries = [...txn().entries, ...txn().entries];
    const [ids] = accountParams(txn({ entries }));
    expect(ids).toEqual(['b/reserved', 'b/source']);
  });

  it('is independent of entry order (two writers lock rows in the same order)', () => {
    const reversed = txn({ entries: txn().entries.toReversed() });
    expect(accountParams(reversed)).toEqual(accountParams(txn()));
  });
});

describe('touchedScopes', () => {
  it('returns distinct scopes, sorted', () => {
    const entries = [
      { account: { scope: 'z', kind: 'source' as const }, direction: 'debit' as const, amount: 1n },
      {
        account: { scope: 'a', kind: 'reserved' as const },
        direction: 'credit' as const,
        amount: 1n,
      },
      {
        account: { scope: 'a', kind: 'source' as const },
        direction: 'credit' as const,
        amount: 1n,
      },
    ];
    expect(touchedScopes(txn({ entries }))).toEqual(['a', 'z']);
  });
});

describe('entryParams', () => {
  it('keeps amounts as exact decimal strings, never JS numbers', () => {
    const [, , , amounts] = entryParams(txn());
    expect(amounts).toEqual([big.toString(), big.toString()]);
    expect(amounts.every((a) => typeof a === 'string')).toBe(true);
  });

  it('keeps arrays aligned with the entries', () => {
    expect(entryParams(txn())).toEqual([
      'txn-1',
      ['b/source', 'b/reserved'],
      ['credit', 'debit'],
      [big.toString(), big.toString()],
    ]);
  });
});
