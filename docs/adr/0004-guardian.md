# 0004 — Guardian co-sign, binding and limits (D3, scenario B tension 2)

- **Status:** proposed
- **Date:** 2026-11-11

## Context
Large claims need a second person (I4). The guardian protects the owner's money, but a guardian
key can be phished, and in scenario B a relative guardian can be the abuser.

## Options
1. Guardian signs every claim. Safe, unusable.
2. **Guardian signs only above a per-spender threshold, over a hash that binds the claim.**
3. Guardian as a full co-owner. Too much power; they could move funds.

## Decision
Option 2.
- **Hash binds:** spender, route, amount, mint, period index, policy version, claim id, expiry.
  Change any field and the approval is invalid.
- **Powers:** approve or reject only. The guardian can never move funds, add routes, change
  rules or change the withdrawal account.
- **Silence:** a pending approval expires to `Expired`; nothing is auto-approved.
- **Veto mode (per policy):** `Final` for scenario A (protects the sender's money; the sender can
  still withdraw, so I11 holds). `Expiring` for scenario B: the owner may resubmit after a longer
  delay without the guardian, so a hostile guardian can't freeze the owner forever.
  `[YOU: delay length for B]`
- **Rotation:** owner rotates the guardian through the rule-change queue (0007, 48h). Guardian may
  resign after a delay but never names their own replacement.

## Consequences
- Guardian plus spender collusion can still take up to the cap → bounded by caps and routes;
  stated as a trust assumption.
- Tests: mutate each bound field, replay, expire, guardian = spender.

## What would change this
Demo users find the threshold confusing, or a real partner offers its own approval step.
