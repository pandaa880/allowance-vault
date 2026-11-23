# 0008 — Exit paths: withdrawal account, pause, upgrade authority (I11, scenario B tension 1)

- **Status:** proposed
- **Date:** 2026-11-11

## Context
I11 says every party can get funds out of every state. In scenario B, "owner withdraws anywhere,
anytime" is exactly what a scammer asks for. Program custody (0002) also needs an emergency stop.

## Options
1. Owner withdraws to any address, anytime. Satisfies I11, opens the scam path.
2. **Owner withdraws anytime, but only to a registered withdrawal account.**
3. Withdrawal needs the guardian. Breaks I11 if the guardian is absent or hostile.

## Decision
Option 2.
- Scenario A: the withdrawal account is the sender's Squads treasury. Withdrawal needs no
  guardian, family, relayer or backend.
- Scenario B: the withdrawal account is the owner's own registered account. Any other destination
  is a new payee with the delay and guardian rule.
- Changing the withdrawal account is a queued rule change (0007).
- **Pause, two levels:** level 1 (owner) stops new claims and releases. Level 2 (upgrade
  multisig) is for a program bug and expires on its own. Withdrawal to the registered account
  works under both.
- **Upgrade authority:** a named multisig, never a single dev key, documented in the README.

## Consequences
- I11 is refined: "to the registered withdrawal account". Update `../05-invariants.md` when
  accepted.
- Tests: withdraw works in every claim state and while paused; withdraw elsewhere fails.

## What would change this
A recovery case where the registered account itself is lost (then Squads recovery in A; an
owner-plus-guardian timelocked change in B).
