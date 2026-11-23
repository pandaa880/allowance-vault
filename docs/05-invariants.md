# 05 — Invariants

> Status: draft (proposed in AGENTS.md). Each confirmed invariant gets at least one property test
> in `programs/allowance-vault/tests/` that fails before the code exists.

| # | Invariant | How it's enforced | Test |
|---|---|---|---|
| I1 | No custody by us: no server key can move user funds | `[ ]` | `[ ]` |
| I2 | Released ≤ funded; releases per period ≤ cap, per beneficiary | `[ ]` | `[ ]` |
| I3 | A claim id releases at most once | `[ ]` | `[ ]` |
| I4 | Claims above threshold need the guardian's signature | `[ ]` | `[ ]` |
| I5 | Only the sender changes rules; changes apply from next period / after timelock | `[ ]` | `[ ]` |
| I6 | Relayer sponsors only whitelisted instructions of this program | `[ ]` | `[ ]` |
| I7 | Stablecoin leg stays offshore; INR payout is off-chain | design | n/a |
| I8 | No personal data on-chain | review | `[ ]` |
| I9 | Integer base units, checked arithmetic, no floats | review + clippy | `[ ]` |
| I10 | Every money-moving instruction emits an event | `[ ]` | `[ ]` |
| I11 | Every party can get their funds out of every state. The sender can revoke and withdraw unclaimed USDC without the guardian, family, relayer or our backend. A guardian veto window or time lock expires on its own, so silence never freezes funds. | `[ ]` | `[ ]` |
| I12 | Every account has a named payer and a named closing handler. Closing returns the rent to whoever paid it. | `[ ]` | `[ ]` |
| I13 | Claim ids come from a per-beneficiary counter that only goes up. Closing a claim account never makes its id reusable. | `[ ]` | `[ ]` |

Property-test idea: generate random sequences of fund / claim / approve / period-advance / rule
change, and assert I2–I5 and I11–I13 after every step.

## v2+ notes (2026-11-20, proposed)
- **I6** applies to whatever pays fees: Kora in the old design, a rate-limited serverless fee-payer
  function in the hosted demo. It sponsors fees for this program's instructions only.
- **I7** holds per route: the partner route keeps the stablecoin leg offshore; the `WALLET` route is
  a devnet demo and scenario B only, never part of a real India configuration.

### Off-chain invariants (slices 1–2)
Property tests (fast-check) assert these after every step of a random sequence of events and
faults. Each gets a name and a failing test first.

| # | Invariant | Slice |
|---|---|---|
| L1 | Paid at most once: one claim id produces at most one partner payout, whatever the retries, crashes or duplicate webhooks | 1 |
| L2 | Every ledger transaction balances (debits = credits) and entries are append-only | 1 |
| L3 | An idempotency key replayed with a different request hash is rejected | 1 |
| L4 | Money is conserved as flows, per claim (reserved ends in exactly one of released or refunded) and per period (authorized = unused + reserved + released + refunded + fx_adjustment); no wording depends on where funds sit (ADR 0012, proposed) | 2 |
| L5 | Before release: a rate move past the 1% tolerance, or an expired quote, never starts a payout without re-confirmation. After the payout starts on a valid quote the sender carries the move (ADR 0011, proposed) | 2 |
| L6 | Chain, ledger and partner statement agree, or the reconciliation report names the mismatch | 3 |

## Gaps found from the book (2026-11-04)

Source: *Building Financial Software on Solana* (MacCana, 2026). Notes are in
`colosseum/research_notes/Building Financial Software on Solana/`. All three rows are proposed until
planning confirms them.

- **I13 refines I3.** If a claim account is closed, the same seeds can create it again. A reused
  claim id could then release twice. The book's fundraiser guards against this with a counter of
  open receipts that must reach zero before close (ch 12). It also uses a counter for ordering
  (ch 5). So derive the claim address from a beneficiary counter that only increases.
- **I11 is missing from the draft.** Every participant must be able to get their assets out of
  every state (ch 6). The program must not depend on a silent admin or a silent oracle (ch 8,
  ch 10). Open question for an ADR: which handlers may run without the guardian's signature.
- **I12 conflicts with I6.** Whoever opens an account pays its rent and gets it back on close
  (ch 6). I6 says the relayer never funds account creation. Decide in an ADR who pays rent for
  claim accounts: the sender's vault, the beneficiary, or a sponsored allowlist.
