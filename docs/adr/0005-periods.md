# 0005 — Periods: fixed 30-day index from a UTC anchor (D4)

- **Status:** proposed
- **Date:** 2026-11-11

## Context
Caps are per period (I2). Calendar months and the Squads "Month" reset are fuzzy, and boundary
bugs can double a cap.

## Options
1. Calendar month. Needs date maths on-chain; varying lengths.
2. **Integer period index:** `(now - anchor) / duration`, `duration = 30 days`.
3. Slots. Not tied to wall time.

## Decision
Option 2. Anchor set once at policy creation, never changed. Half-open periods
`[start, start + duration)`. One function computes the index and every check uses it. Unused cap
doesn't roll over. Several claims per period are allowed while their sum ≤ cap, with **at most one
pending claim per spender** at a time.

## Consequences
- Copy says "every 30 days", not "monthly".
- Validator timestamps drift a few seconds; tests cover `start - 1`, `start`, `end - 1`, `end`
  with LiteSVM clock overrides, plus random sequences across missed periods.

## What would change this
Users need calendar-aligned allowances (school fee due dates) and a simple off-chain schedule
can't cover it.
