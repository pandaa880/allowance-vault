# 0009 — Who pays fees and rent (I6 vs I12)

- **Status:** proposed
- **Date:** 2026-11-11

## Context
Family members have no SOL (gasless). Kora sponsors fees but must never fund arbitrary account
creation (I6). Every account needs a named payer who gets rent back on close (I12). Claim PDAs
need rent.

## Options
1. Kora pays claim rent. Breaks I6; Kora #720 behaviour unverified.
2. Spender pays. Breaks gasless.
3. **Owner funds a small SOL rent-reserve PDA at setup; claim accounts draw rent from it and
   return it on close.**
4. Owner prefunds each family wallet with SOL. Clunky; SOL sits in India-resident wallets.

## Decision
Option 3. Kora's allowlist covers only this program's instructions and pays only the transaction
fee. The rent reserve is a system-owned PDA the program signs for when it creates a claim account.
Closing a terminal claim returns rent to the reserve. Partner settlement token accounts are created
by the partner, not by us.

## Consequences
- Setup asks the owner for a little SOL in addition to USDC; the UI shows it in dollars.
- Falsification test 8 must confirm a first-time claim works with zero SOL in the spender wallet
  and measure rent vs fees. `[YOU: run before accepting]`

## Update 2026-11-20 (v2+, proposed)
Kora is backlog. The hosted wallet-route demo pays fees with one rate-limited serverless fee-payer
function: it signs fees only, allowlists this program's instructions, and holds no key that can move
user funds (I1, I6). It is a single point of failure (finding R7); the demo states that as a limit.
The rent-reserve decision above is unchanged.

## What would change this
Test 8 shows PDA-funded creation fails or costs more than expected; fallback = claims stored in a
fixed-size ring inside the policy account (no per-claim rent).
