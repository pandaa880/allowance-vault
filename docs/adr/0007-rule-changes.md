# 0007 — Rule changes: versioned, queued, timelocked (D6, scenario B tension 3)

- **Status:** proposed
- **Date:** 2026-11-11

## Context
Rule changes can front-run pending claims, and in scenario B a scammer can coerce the owner into
removing protections. I5: only the owner changes rules.

## Options
1. Instant changes. Front-running and coercion are one transaction away.
2. **Queue with `effective_at = max(next period start, now + 48h)`**, versioned policy.
3. Guardian must approve every rule change. Gives the guardian control over the owner.

## Decision
Option 2.
- Every policy has a `policy_version`; claims and guardian approvals commit to it.
- Changes are queued, emit an event (the guardian gets an alert), and apply only at
  `effective_at`. The owner can cancel a queued change.
- Queued: caps, threshold, guardian add/remove/rotate, routes, withdrawal account (0008).
- On apply, pending claims on the old version become `Cancelled`.
- Pause is separate (0008): it can stop releases immediately but never redirects funds.

## Consequences
- Rules can't be loosened quickly, even legitimately. Tightening (lower cap) also waits; accept
  for v1. *Superseded by the 2026-11-23 update below.*
- Tests: claim with stale version fails; change applies exactly at `effective_at`.

## Update 2026-11-23 (OQ-14, proposed)
Answers the open question above: **tightening is instant, loosening is delayed.**
- **Tightening** takes effect at once: lower cap, shorter period, remove payee, revoke key, pause.
  An emergency needs speed, and nothing here helps an attacker.
- **Loosening** is queued and applies after **1 day**, configurable per environment (minutes in the
  hosted demo): raise cap, add payee, add key, extend period, resume, remove guardian. A mixed change
  counts as loosening. This replaces the `max(next period start, now + 48h)` rule for loosening, and
  it applies mid-period; invariant 5 already allowed "after a timelock". Cost, stated plainly: a
  hacked or coerced sender gets a shorter window to notice, and the guardian alert and cancel are the
  safety net. **Removing the guardian waits longer** because it removes that safety net; 7 days,
  configurable.
- **Cancel:** the sender and the guardian can each cancel a pending loosening. Pending loosenings are
  visible to everyone, with a cancel action. Without visibility the delay protects nobody.
- **Lockout:** the guardian can undo a lockout instantly. An instant undo may only restore the rule
  version that was in force before the first tightening of the current lockout, never go beyond it,
  so a compromised guardian key cannot loosen quickly. A mixed change counts as loosening and cannot
  be undone instantly. An instant undo alerts the sender and shows on the audit view. Note, not a
  feature: the sender can tighten again after an undo, so a cooldown or rate limit may be needed.
- **Denial of service:** a stolen sender key can use instant tightening to freeze the family (cap to
  zero, revoke their key). That is recoverable through the guardian; a drained vault is not.
- Each claim keeps committing to the `policy_version` active when it was made (unchanged).
- Tests: tightening applies in the same block; loosening does not apply before its delay; a cancel by
  either party stops it; the guardian undo restores only the version before the first tightening of the lockout.

## What would change this
Demo or user feedback that 48h blocks a real emergency; then allow instant tightening only.
