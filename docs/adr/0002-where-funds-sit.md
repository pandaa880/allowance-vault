# 0002 — Where funds sit (D1)

- **Status:** proposed
- **Date:** 2026-11-11

## Context
Feasibility review D1. Holding USDC in India is the main legal exposure (VDA tax, FEMA). The
sender must stay in control; we must hold no key that moves funds (I1).

## Options
1. Family wallets receive USDC. Simple; puts a VDA in an India resident's hands.
2. Squads spending limit pays family directly. Same problem; Squads has no claim workflow.
3. **Squads treasury → capped top-up → program-owned vault PDA → only allowlisted route
   settlement accounts.**
4. SF Subscriptions pulls monthly from the sender. Broad delegate shown to wallets (issue #264);
   review advises against a blind sweep.

5. **Squads Smart Account policies + our program as a post-hook (hybrid)** — added 2026-11-13
   after a code-read spike (`../../../research/spike-squads-smart-account-policy-2026-11-13.md`).
   Funds never leave the user's smart account until paid to an allowlisted route; Squads enforces
   destinations, 30-day caps, per-use limit, guardian threshold and timelock; our program records
   the claim and partner receipt. Costs: SDK not on npm, new feature, global hook signer needs a
   binding check, more transactions on the guardian path.

## Decision
`[YOU: choose 3 or 5 after devnet falsification tests 1–4 in the spike note]`

Draft as written before the spike — option 3. The sender's Squads account tops up the vault (within a Squads spending limit or by
proposal). The vault's token account authority is a program PDA. USDC leaves the vault only to a
route's settlement account (0001). In the India configuration **the spender never holds USDC**;
their key only authorises claims. SF Subscriptions is not used in v1.

Squads product (v4 multisig `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` vs the smart-account
program) is pinned after falsification test 1. `[YOU: pick after the test]`

## Consequences
- Funds sit in program custody between top-up and release → upgrade authority in a named multisig
  and a pause that never redirects (0007, 0008).
- Track funded and released amounts in program state, not the vault balance (a direct transfer
  into the vault must not raise what the program owes).
- Extra rent and a CPI hop; falsification test 3 must show the caller can't swap token program,
  mint, vault or destination.

## Update 2026-11-20 (v2+, proposed)
- **D1 is decided in slice 3**, after the Squads devnet tests. It doesn't block slices 1–2: the ledger
  models funded → released → partner-confirmed the same way under option 3 or 5.
- "The spender never holds USDC" now applies to the **partner route** (and any real India
  configuration). The **wallet route** (ADR 0003 update) pays USDC to the family wallet and exists
  only as a devnet demo and for scenario B.
- If slice 3 runs long, the cut order is: shorten the slice 2 catalogue first, then drop the Squads
  policy integration and take option 3.
- SF Subscriptions stays out (backlog).

## What would change this
Legal advice that a family member authorising (not holding) is no better than holding; or test 3
fails; or Squads can't express a capped top-up.
