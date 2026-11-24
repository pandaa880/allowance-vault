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
  /** Id generator, injected by the composition root so this layer stays free of platform APIs. */
  newId: () => string;
}

const uniqueSorted = (values: string[]): string[] => [...new Set(values)].toSorted();

export function createLedger({ repo, newId }: LedgerDeps) {
  /**
   * The only way entries reach the journal. Every posting, whatever its kind:
   * 1. validates the entries (L2),
   * 2. locks each touched scope in sorted order (no deadlock, and the cap check below cannot
   *    interleave with another writer of the same scope),
   * 3. claims the idempotency key once (L3),
   * 4. writes, then re-derives `unused` per scope and rolls everything back if one went negative.
   * Correctness relies on READ COMMITTED (each statement after the lock sees fresh data); the
   * repository starts every unit of work at that level.
   */
  async function post(tx: LedgerTx, request: PostingRequest): Promise<PostResult> {
    assertBalanced(request.entries);
    const scopes = uniqueSorted(request.entries.map((e) => e.account.scope));
    for (const scope of scopes) await tx.lockScope(scope);

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
    for (const scope of scopes) {
      const { unused } = summarize(await tx.scopeTotals(scope));
      if (unused < 0n) throw new OverCommitted(scope, unused);
    }
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

  /** Sets aside `amount` for a claim; refused when it would push `unused` below zero. */
  const reserveClaim = (cmd: ReserveClaim): Promise<PostResult> =>
    postTransaction({
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

  const periodSummary = (scope: string): Promise<PeriodSummary> =>
    repo.withTransaction(async (tx) => summarize(await tx.scopeTotals(scope)));

  return { postTransaction, fundAllowance, reserveClaim, periodSummary };
}

export type Ledger = ReturnType<typeof createLedger>;
