# 0003 — Categories are payee routes, not merchant codes (D2)

- **Status:** proposed
- **Date:** 2026-11-11

## Context
Cards get trustworthy merchant category codes from the network. Solana transfers carry none, so
an on-chain "school fees" label proves nothing by itself.

## Options
1. Free-text or enum category chosen by the family, no enforcement.
2. **Category = allowlisted route.** A claim names a route; the route fixes where USDC goes.
3. Partner attests the real-world category after payout. Needs a real partner; v1 has a mock.

## Decision
Option 2, with option 3's receipt as extra evidence. `category_id → route_id`. A claim carries the
category and an opaque `biller_ref_hash` (hash of the partner-side biller reference, no PII). The
UI says "family selected" for the declared category and "partner confirmed" only after a signed
receipt (0010).

## Consequences
- The chain proves the route and the declared category, not the real-world purchase. Copy must
  never say "merchant categories enforced".
- Adding a route is a rule change (0007).

## Update 2026-11-20 (v2+, proposed)
- A route has a **kind**: `WALLET` (USDC to the family member's own wallet, in the claim's transaction) or a
  partner kind (`AD_BANK_WIRE | RDA | MTSS`, USDC to the partner's settlement account, INR off-chain).
- Same caps, periods, guardian and claim lifecycle for both. A `WALLET` route has no attester: the claim is
  final at `Released` (no `PartnerConfirmed` step).
- `WALLET` routes are for the devnet demo and scenario B. In a real India configuration no `WALLET` route
  exists (ADR 0002 legal note).
- Adding a `WALLET` route is a rule change like any other (0007).

## What would change this
A partner that returns a signed biller category we can verify, or a card-based payout (scenario
B) where the issuer enforces merchant codes.
