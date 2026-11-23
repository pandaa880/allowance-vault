import { randomUUID } from 'node:crypto';
import { IdempotencyConflict, OverCommitted } from '../domain/errors.js';
import {
  assertBalanced,
  requestHash,
  summarize,
  type Currency,
  type PeriodSummary,
  type PostingRequest,
} from '../domain/journal.js';
import type { LedgerRepository, LedgerTx } from './ports.js';

export interface PostResult {
  status: 'created' | 'replayed';
  txnId: string;
}

export interface FundAllowance {
  idempotencyKey: string;
  scope: string;
  currency: Currency;
  amount: bigint;
}

export interface ReserveClaim extends FundAllowance {
  claimId: string;
}

export interface LedgerDeps {
  repo: LedgerRepository;
  newId?: () => string;
}

export function createLedger({ repo, newId = randomUUID }: LedgerDeps) {
  /** Validates, then posts once per idempotency key (L2, L3). Runs inside the caller's unit of work. */
  async function post(tx: LedgerTx, request: PostingRequest): Promise<PostResult> {
    assertBalanced(request.entries);
    const hash = requestHash(request);
    const txnId = newId();
    const claim = await tx.claimIdempotencyKey(request.idempotencyKey, hash, txnId);
    if (claim.outcome === 'exists') {
      if (claim.requestHash !== hash) throw new IdempotencyConflict(request.idempotencyKey);
      return { status: 'replayed', txnId: claim.txnId };
    }
    await tx.insertTransaction({
      id: txnId,
      kind: request.kind,
      claimId: request.claimId,
      currency: request.currency,
      entries: request.entries,
    });
    return { status: 'created', txnId };
  }

  const postTransaction = (request: PostingRequest): Promise<PostResult> =>
    repo.withTransaction((tx) => post(tx, request));

  /** `AllowanceFunded`: credit `authorized` against the system `source`. */
  const fundAllowance = (cmd: FundAllowance): Promise<PostResult> =>
    postTransaction({
      idempotencyKey: cmd.idempotencyKey,
      kind: 'fund',
      claimId: null,
      currency: cmd.currency,
      entries: [
        { account: { scope: cmd.scope, kind: 'source' }, direction: 'debit', amount: cmd.amount },
        {
          account: { scope: cmd.scope, kind: 'authorized' },
          direction: 'credit',
          amount: cmd.amount,
        },
      ],
    });

  /** Sets aside `amount` for a claim; refuses when it would push `unused` below zero. */
  const reserveClaim = (cmd: ReserveClaim): Promise<PostResult> =>
    repo.withTransaction(async (tx) => {
      await tx.lockScope(cmd.scope);
      const result = await post(tx, {
        idempotencyKey: cmd.idempotencyKey,
        kind: 'reserve',
        claimId: cmd.claimId,
        currency: cmd.currency,
        entries: [
          {
            account: { scope: cmd.scope, kind: 'reserved' },
            direction: 'debit',
            amount: cmd.amount,
          },
          {
            account: { scope: cmd.scope, kind: 'source' },
            direction: 'credit',
            amount: cmd.amount,
          },
        ],
      });
      // `post` already wrote the entries, so `unused` below is the value after this reserve.
      // A negative result throws, which rolls the whole unit of work back (nothing is written).
      const { unused } = summarize(await tx.scopeTotals(cmd.scope));
      if (result.status === 'created' && unused < 0n) {
        throw new OverCommitted(cmd.scope, unused + cmd.amount, cmd.amount);
      }
      return result;
    });

  const periodSummary = (scope: string): Promise<PeriodSummary> =>
    repo.withTransaction(async (tx) => summarize(await tx.scopeTotals(scope)));

  return { postTransaction, fundAllowance, reserveClaim, periodSummary };
}

export type Ledger = ReturnType<typeof createLedger>;
