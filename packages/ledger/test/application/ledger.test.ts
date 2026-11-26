import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLedger } from '../../src/application/ledger.js';
import type { LedgerRepository } from '../../src/application/ports.js';
import {
  CurrencyMismatch,
  IdempotencyConflict,
  InvalidRequest,
  LockTimeout,
  OverCommitted,
  UnbalancedTransaction,
} from '../../src/domain/errors.js';
import { err } from '../../src/domain/result.js';

// No database: the repository fails the way the real one does, so these tests pin only how the
// use case turns failures into results. The pg integration tests cover the same paths for real.
const failingWith = (error: unknown): LedgerRepository => ({
  withTransaction: () => Promise.reject(error),
});
const unreachable: LedgerRepository = {
  withTransaction: () => Promise.reject(new Error('the repository must not be called')),
};
const ledgerOver = (repo: LedgerRepository) => createLedger({ repo, newId: randomUUID });

const fund = (repo: LedgerRepository) =>
  ledgerOver(repo).fundAllowance({
    idempotencyKey: randomUUID(),
    scope: 'period-1',
    currency: 'USDC',
    amount: 10n,
  });

const accepting: LedgerRepository = {
  withTransaction: (work) =>
    work({
      lockScopes: () => Promise.resolve(),
      claimIdempotencyKey: () => Promise.resolve({ outcome: 'claimed' }),
      insertTransaction: () => Promise.resolve(),
      scopeTotals: () => Promise.resolve({}),
    }),
};

it('a posting that goes through comes back as ok', async () => {
  const outcome = await fund(accepting);
  expect(outcome).toMatchObject({ ok: true, value: { status: 'created' } });
});

describe('expected refusals come back as values', () => {
  it('IdempotencyConflict', async () => {
    const outcome = await fund(failingWith(new IdempotencyConflict('key-1')));
    expect(outcome).toEqual(err({ kind: 'IdempotencyConflict', idempotencyKey: 'key-1' }));
  });

  it('OverCommitted, with the scope and how far it would go below zero', async () => {
    const outcome = await fund(failingWith(new OverCommitted('period-1', -7n)));
    expect(outcome).toEqual(err({ kind: 'OverCommitted', scope: 'period-1', unusedAfter: -7n }));
  });

  it('CurrencyMismatch, with the currency that was refused', async () => {
    const outcome = await fund(failingWith(new CurrencyMismatch('USDC', 'scope holds INR')));
    expect(outcome).toEqual(err({ kind: 'CurrencyMismatch', currency: 'USDC' }));
  });
});

describe('caller bugs and infrastructure failures still throw', () => {
  it('a malformed request throws InvalidRequest before the repository is used', async () => {
    await expect(ledgerOver(unreachable).postTransaction(null)).rejects.toBeInstanceOf(
      InvalidRequest,
    );
  });

  it('an unbalanced request throws UnbalancedTransaction before the repository is used', async () => {
    const scope = 'period-1';
    const unbalanced = {
      idempotencyKey: randomUUID(),
      kind: 'reserve',
      claimId: randomUUID(),
      currency: 'USDC',
      entries: [
        { account: { scope, kind: 'reserved' }, direction: 'debit', amount: 2n },
        { account: { scope, kind: 'source' }, direction: 'credit', amount: 1n },
      ],
    };
    await expect(ledgerOver(unreachable).postTransaction(unbalanced)).rejects.toBeInstanceOf(
      UnbalancedTransaction,
    );
  });

  it('LockTimeout propagates, so the caller can retry', async () => {
    await expect(fund(failingWith(new LockTimeout('busy')))).rejects.toBeInstanceOf(LockTimeout);
  });

  it('an unknown error propagates unchanged', async () => {
    const boom = new Error('connection reset');
    await expect(fund(failingWith(boom))).rejects.toBe(boom);
  });
});
