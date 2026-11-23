# 0010 — Payout receipts and partner attestation

- **Status:** proposed
- **Date:** 2026-11-11

## Context
The INR leg happens off-chain at a (mock) licensed partner. Both sides want a receipt, but the
chain can't see a bank transfer. Overclaiming "paid" would be misleading.

## Options
1. Our backend marks claims paid. Trusts us; breaks the trust model.
2. **Partner attester key, registered per route, signs a receipt hash on-chain.**
3. Receipt NFTs. Extra cost, no stronger evidence.

## Decision
Option 2.
- The partner acts only on `ClaimReleased` at finalized commitment.
- `confirm_payout(claim_id, state, receipt_hash)` requires the route's attester signature; it
  moves `Released → PartnerConfirmed` or `PayoutFailed`, once (idempotent; replays fail).
- `receipt_hash = sha256(canonical receipt JSON)`; the JSON (off-chain) holds the INR amount,
  `partnerToken` (an opaque token the partner can resolve to the bank reference; must be non-empty for
  `CREDITED`) and an optional FIRA/advice id. The bank reference (UTR/SWIFT) stays at the partner and
  is never in a receipt (ADR 0011, OQ-17; reworded 2026-11-23, proposed).
- A partner that goes silent leaves the claim at `Released`; the UI says "sent to partner,
  not confirmed".
- Mock: its own devnet attester key; every screen and receipt says **SIMULATED**.

## Consequences
- The chain proves the partner signed, not that INR arrived. Copy says exactly that.
- Attester key rotation is a queued rule change (0007).

## Update 2026-11-20 (v2+, proposed)
- Applies to **partner routes only**. A `WALLET` route has no receipt step (ADR 0003 update).
- The off-chain mock partner signs its webhooks with HMAC (slice 1) and returns FX quotes with an
  expiry (slice 2). The attester key and `confirm_payout` land with the program in slice 3.
- A partner reversal after `CREDITED` is a ledger event in slice 2; the on-chain consequence is
  decided in slice 3.

## What would change this
A real partner with its own signed webhook or on-chain attestation format (then adapt to it).
