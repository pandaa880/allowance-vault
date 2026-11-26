import { IdempotencyConflict, OverCommitted } from '../domain/errors.js';
import {
  assertBalanced,
  requestHash,
  summarize,
  touchedScopes,
  type Currency,
  type PeriodSummary,
  type PostingRequest,
} from '../domain/journal.js';
import type { LedgerRepository, LedgerTx } from './ports.js';
import { parsePostingRequest } from './schemas.js';

export interface PostResult {
  readonly status: 'created' | 'replayed';
  readonly txnId: string;
}

export interface FundAllowance {
  readonly idempotencyKey: string;
  readonly scope: string;
  readonly currency: Currency;
  readonly amount: bigint;
}

export interface ReserveClaim extends FundAllowance {
  readonly claimId: string;
}

export interface LedgerDeps {
  readonly repo: LedgerRepository;
  /** Id generator, injected by the composition root so this layer stays free of platform APIs. */
  readonly newId: () => string;
}

export interface Ledger {
  /** Posts any balanced set of entries once per idempotency key. `request` is validated first. */
  postTransaction(request: unknown): Promise<PostResult>;
  /** `AllowanceFunded`: credit `authorized` against the system `source`. */
  fundAllowance(cmd: FundAllowance): Promise<PostResult>;
  /** Sets aside `amount` for a claim; refused when it would push `unused` below zero. */
  reserveClaim(cmd: ReserveClaim): Promise<PostResult>;
  periodSummary(scope: string): Promise<PeriodSummary>;
}

export function createLedger({ repo, newId }: LedgerDeps): Ledger {
  /**
   * The only way entries reach the journal. Every posting, whatever its kind:
   * 1. is already validated and copied (see `postTransaction`),
   * 2. locks each touched scope in one fixed order (no deadlock, and the cap check below cannot
   *    interleave with another writer of the same scope),
   * 3. claims the idempotency key once (L3),
   * 4. writes, then re-derives `unused` per scope and rolls everything back if one went negative.
   * Correctness relies on READ COMMITTED (each statement after the lock sees fresh data); the
   * repository starts every unit of work at that level.
   */
  async function post(tx: LedgerTx, request: PostingRequest): Promise<PostResult> {
    const scopes = touchedScopes(request.entries);
    await tx.lockScopes(scopes);

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

  // Validation and the balance rule run first, once, before a connection is taken: a bad request
  // never uses the pool, and the copy made here is what gets posted even if the caller changes
  // its own array while the posting waits for a connection or a lock.
  const postTransaction: Ledger['postTransaction'] = async (input) => {
    const request = parsePostingRequest(input);
    assertBalanced(request.entries);
    return repo.withTransaction((tx) => post(tx, request));
  };

  return {
    postTransaction,

    fundAllowance: (cmd) =>
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
      }),

    reserveClaim: (cmd) =>
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
      }),

    periodSummary: (scope) =>
      repo.withTransaction(async (tx) => summarize(await tx.scopeTotals(scope))),
  };
}
