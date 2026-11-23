# 0006 — Claim lifecycle and one spender role (D5, scenario B tension 4)

- **Status:** proposed
- **Date:** 2026-11-11

## Context
Money moves only through claim transitions. Scenario A's spender is a family member; scenario B's
spender is the owner. One state machine should serve both.

## Options
1. Separate instructions per scenario. Duplicated checks.
2. **One `spender` role and one claim state machine.**

## Decision
Option 2.
- **States:** `Requested → Approved (only if above threshold) → Released → PartnerConfirmed`.
  Terminal: `Rejected`, `Expired`, `Cancelled`, `PayoutFailed`.
- **One handler per transition**; each checks the current state, the signer and the recorded
  relationship, and names the broken rule in its error.
- **Address:** claim PDA seeds `(policy, spender, claim_counter)`; the counter only goes up, so a
  closed claim id is never reused (I3, I13).
- **Events:** every transition emits one, with an opaque claim id and no PII (I8, I10).
- **PayoutFailed:** USDC already sits with the partner. v1 records the failure; refund to the vault
  needs a partner-signed return. `[YOU: in scope for v1?]`

## Consequences
- The diagram in `../04-accounts.md` needs a `stateDiagram-v2` from this list.
- Released and PartnerConfirmed stay separate so the UI never shows "paid" on our word alone.

## Update 2026-11-20 (v2+, proposed)
- **Wallet route claims** go `Requested → Approved (if above threshold) → Released` and stop there:
  no attester, so no `PartnerConfirmed`. Released is final.
- **PayoutFailed refund question:** slice 2 answers it with partner reversals. A reversal after
  "success" and a bank failure both post refund entries in the ledger. Whether a refund restores
  the period's cap is decided in that slice's ADR (finding R11).
- Slice 1 models the lifecycle off-chain behind a fake `ClaimReleased` source. The on-chain claim PDA
  lands in slice 3.

## What would change this
Scenario B needs a transition A can't share (for example scheduled recurring bills).
