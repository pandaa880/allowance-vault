# 0001 — Market-neutral program, payout adapter per market (India first)

- **Status:** proposed
- **Date:** 2026-11-11

## Context
Two scenarios share one program: A, India family allowance (primary) and B, US elder money
guardian (second demo). They differ mainly in how money leaves the chain, and that is also where
the legal risk sits (INR via licensed rails in A, card or ACH partners in B).

## Options
1. India-specific program (INR fields, India rules in code). Cheap now; scenario B needs a fork.
2. **Market-neutral program + off-chain payout adapter per market.** The program knows routes,
   not countries.
3. Generic transfers to any address. Simplest, but nothing stops USDC reaching an India-resident
   wallet, and categories mean nothing.

## Decision
Option 2. The program stores **routes**: `route_id → settlement token account, partner attester
key, kind`. Off-chain, each market has a `LicensedPayoutPartner` adapter (interface sketch in
`../../../HANDOFF.md`). **First and only adapter for v1: India licensed-partner mock**
(`AD_BANK_WIRE | RDA | MTSS`; `PA_CB` is a separate trade flow, out of scope).

## Consequences
- Easier: scenario B later = new adapter + config, no program fork.
- The India configuration has **no route that pays a spender wallet** (see 0002).
- Harder: route registry, attester keys and receipts are extra accounts and checks (0010).
- Rules out: country logic, FX rates or INR amounts inside the program (INR lives in the
  off-chain receipt only).

## What would change this
A real partner needs settlement data the route model can't carry (for example travel-rule data
attached to the transfer), or scenario B needs handlers that don't fit the shared state machine.
