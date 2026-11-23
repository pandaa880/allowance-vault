import { describe, expect, it } from 'vitest';
import { UnbalancedTransaction } from '../../src/domain/errors.js';
import { assertBalanced, requestHash, type PostingRequest } from '../../src/domain/journal.js';

const big = 2n ** 60n + 7n; // above Number.MAX_SAFE_INTEGER

const request = (overrides: Partial<PostingRequest> = {}): PostingRequest => ({
  idempotencyKey: 'k1',
  kind: 'reserve',
  claimId: 'claim-1',
  currency: 'USDC',
  entries: [
    { account: { scope: 'p1', kind: 'reserved' }, direction: 'debit', amount: big },
    { account: { scope: 'p1', kind: 'source' }, direction: 'credit', amount: big },
  ],
  ...overrides,
});

describe('assertBalanced (L2, domain)', () => {
  it('accepts debits equal to credits, even above 2^53', () => {
    expect(() => assertBalanced(request().entries)).not.toThrow();
  });

  it('rejects debits that differ from credits', () => {
    const entries = request().entries.map((e, i) => (i === 0 ? { ...e, amount: big + 1n } : e));
    expect(() => assertBalanced(entries)).toThrow(UnbalancedTransaction);
  });

  it('rejects a single-entry transaction', () => {
    const [first] = request().entries;
    expect(() => assertBalanced(first ? [first] : [])).toThrow(UnbalancedTransaction);
  });

  it('rejects zero and negative amounts', () => {
    const zero = request().entries.map((e) => ({ ...e, amount: 0n }));
    expect(() => assertBalanced(zero)).toThrow(UnbalancedTransaction);
  });
});

describe('requestHash (L3, domain)', () => {
  it('is stable for the same request', () => {
    expect(requestHash(request())).toBe(requestHash(request()));
  });

  it('ignores the idempotency key itself', () => {
    expect(requestHash(request({ idempotencyKey: 'other' }))).toBe(requestHash(request()));
  });

  it('changes when the amount changes', () => {
    const changed = request().entries.map((e) => ({ ...e, amount: big + 1n }));
    expect(requestHash(request({ entries: changed }))).not.toBe(requestHash(request()));
  });
});
