# AGENTS.md

> **Scope v2 (2026-11-17):** slices per `../../colosseum/PLAN-roles-projects-prep-2026-11.md` §3. Slice 1 is off-chain (ledger, payout workflow, mock partner); program code starts in slice 3. Kora and SF `subscriptions` are backlog, so the trust-model lines that mention them describe the pre-v2 design until an ADR updates them. The invariants still apply. **v2+ (2026-11-20):** two payout routes under the same rules: wallet route (USDC straight to the family wallet, hosted devnet demo) and partner route (INR via the mock partner, local demo); FX quotes + reversals in slice 2; transaction landing + devnet setup in slice 3; hosted demo + fault panel in slice 4. Slice 1 is unchanged.

Guidance for AI coding agents (and humans) working in this repo. Read this first, then `docs/README.md`.

> **Status (2026-10-31): skeleton, pre-design.** The program still contains Anchor's template
> sample (`initialize` / `increment`). It gets replaced in the first feature PR, after the design
> docs in `docs/` are written and the user says "confirm". Everything marked *proposed* below is a
> starting point for planning, not a decision. Business notes live outside this repo (`../`).

## What this project is
Family Allowance Vault: a person abroad (an NRI) funds a USDC allowance for family members in
India, with rules — monthly caps, spending categories, time-locked releases, a guardian who
co-signs large claims — and an audit trail both sides trust. Family members never need SOL
(gasless claims). The INR payout leg is a **mock** of a licensed partner; this repo never moves
real money and never converts INR to stablecoins inside India.

**Second demo scenario (decided 2026-11-11): US elder money guardian.** A parent pays their own
bills from their own vault; an adult child is a guardian who can reject or delay, never move funds.
Keep the program market-neutral (owner, spender, guardian, payee routes); the market lives in the
payout adapter. Open tensions with invariant 11 are listed in `docs/04-accounts.md`.

Building blocks (proposed): a **Squads smart account** holds the sender's treasury and enforces
per-beneficiary spending limits; our Anchor `allowance_vault` program adds what Squads doesn't
(categories, time locks, guardian co-sign, claim requests, receipts); Solana Foundation
`subscriptions` handles the monthly pull; **Kora** relays family transactions so they pay no fees.

## Trust model (proposed — confirm in planning)
- **Trusted:** the sender's signers on the Squads smart account; the Squads program; this repo's
  program rules once deployed; the guardian's key for co-signing.
- **Untrusted:** our web app and any backend, the Kora relayer, the payout-partner mock, RPC
  providers, and family members' devices (they can be phished).
- Every change must answer: *if our backend, the relayer or a family device is compromised, can
  more money leave than the sender's rules allow, or can it go anywhere else?* The answer must be no.

### Invariants (proposed — confirm in planning; never relax "temporarily")
1. **No custody by us.** Our servers hold no key that can move user funds. The fee payer (Kora in the
   old design, a rate-limited serverless function in the v2+ hosted demo) pays fees only.
2. **Released ≤ funded**, and releases in a period ≤ that period's cap, per beneficiary.
3. **No double release:** one claim id releases at most once (idempotent claims).
4. Claims above the sender's threshold need the **guardian's co-signature**.
5. **Only the sender** (through the Squads smart account) changes rules; changes apply from the
   next period (or after a timelock — decide in an ADR).
6. The relayer can sponsor **only** this program's whitelisted instructions; it never funds
   arbitrary account creation.
7. **Stablecoin leg offshore.** INR payout is an off-chain mock of a licensed partner. On the partner
   route, family wallets only authorise claims. On the v2+ `WALLET` route USDC goes to the family
   wallet: devnet demo and scenario B only, never in a real India configuration (ADR 0003 update).
8. **No personal data on-chain:** pubkeys, amounts, category codes, timestamps and hashes only.
9. Money is integer base units with checked arithmetic; no floats anywhere (program, client, UI).
10. Every money-moving instruction emits an event the audit view can read.
11. **Every party can get their funds out of every state.** The sender can revoke and withdraw
    unclaimed USDC without the guardian, family, relayer or our backend. A guardian veto window or
    time lock expires on its own, so silence never freezes funds.
12. **Every account has a named payer and a named closing handler.** Closing returns the rent to
    whoever paid it. (Conflicts with 6 for claim accounts: who pays their rent is an open ADR.)
13. **Claim ids come from a per-beneficiary counter that only goes up.** Closing a claim account
    never makes its id reusable. This is how 3 is enforced: closed PDAs can be re-created from the
    same seeds.

## Design guidance from *Building Financial Software on Solana* (proposed)
Source: Mike MacCana's book (Quicknode, 2026). Notes are in
`../../colosseum/research_notes/Building Financial Software on Solana/`, and the tested code is
at solanabook.org. Chapter numbers refer to the book. Treat this as input to the design docs, not
as decisions.

- **State machine first (ch 6).** Draw the claim lifecycle (requested → approved → released, plus
  rejected and expired) before writing handlers. Give each transition one handler. Make terminal
  states explicit, ideally by closing the account. Check the state, not only the signer, and name
  the broken rule in each error.
- **Vault and stored terms (ch 4, ch 11).** Keep funds in a token account whose authority is a
  program PDA, with the rules stored in program accounts. Funds then move only along handler code
  paths.
- **Count in program state, not vault balances (ch 12).** Track funded and released amounts in
  your own fields. A direct transfer into the vault must not change what the program believes it
  owes (invariant 2).
- **Account validation (ch 9).** Check four things for every supplied account: signer, owner
  program, the address recorded when the relationship was created, and the PDA seeds with the
  stored bump. A claim needs both the signer check and a check that the signer is the recorded
  beneficiary. Check each allowlisted payee against its recorded address, because a substituted
  destination is the "confused deputy" attack. Every chain of accounts starts from one the
  program derived or recorded itself.
- **Time (ch 5).** Use the Unix timestamp for monthly periods and time locks, and a counter for
  ordering. Compute the period number from one stored start time, and use the same expression for
  "within cap" and "new period" so there is no gap or overlap. Say in the terms whether a month
  means 30 days or a calendar month. Leave a margin of a few seconds at each boundary, because a
  leader can shift the timestamp slightly.
- **Tokens and math (ch 3, ch 7).** Read decimals from the mint and transfer with
  `transfer_checked()`. Support both token programs through the token interface. Before
  accepting PYUSD, USDG or CASH, check their extensions: pausable, permanent delegate, transfer
  hook and default-frozen accounts. Use integers with checked arithmetic, multiply before dividing,
  and round any division against the user.
- **Snapshot terms (ch 8, ch 10).** Rule changes apply only to later periods, which invariant 5
  already says. Bound every parameter when it is written.
- **Roles are users too (ch 9).** Test the cases where the guardian is also a beneficiary, and
  where a guardian and a family member collude.
- **Offchain facts (ch 8).** If a category is proven by a payout-partner attestation, treat the
  partner as an oracle. Check where the attestation came from and how fresh it is. Decide what
  happens when the partner stops publishing.
- **Operations (ch 10):**
  - The mock INR payout acts only on transactions at the finalized commitment level.
  - Use a two-level pause. The first level stops new claims. The second level, if one exists,
    needs a stricter authority and expires on its own. The sender's withdrawal never stops.
  - Put the upgrade authority in a named multisig.
  - The events from invariant 10 can drive alerts on rule changes and unusual outflows, for
    example in Solana Microscope.
- **Tests (ch 10):**
  - A claim exactly at the cap passes, and one more minor unit fails.
  - Rewrite the clock in LiteSVM to cross period boundaries.
  - Use unequal, recognisable amounts.
  - Name a test after each attack.
  - Write round-trip and conservation invariant tests.
  - Optionally, model-check the cap arithmetic with Kani.
- **Product copy (ch 21).** Quote everything in dollars and time, keep keys and signing behind the
  product, and state the benefit and the risk in plain words.

## Repo map
```text
programs/allowance-vault/   Anchor program (template sample until slice 3). tests/ = Rust LiteSVM tests.
app/                        planned, slice 4: TanStack Start app (Sender, Family, Guardian, Audit views).
packages/                   planned: ledger, payout-workflow, mock-partner, events (slice 1);
                            client (slice 3); ui (slice 4). See packages/README.md.
docs/                       design docs, ADRs, threat model, invariants, build log.
.github/workflows/ci.yml    Rust fmt + clippy (untested until the first push).
```

## Toolchain
- Anchor CLI 1.2.1 (`Anchor.toml` pins it), Solana CLI 4.3.2, Rust channel from
  `rust-toolchain.toml` (1.89.0, Anchor template default).
- Tests: Rust LiteSVM (template ships `litesvm = "0.10.0"`; newer releases exist — ask before bumping).
- Off-chain (slice 1, v2+): TypeScript everywhere; Temporal (TypeScript SDK, local dev server only);
  Postgres (double-entry ledger, integer base units); zod; vitest + fast-check. Docker runtime needed.
- Web/clients (when added): TypeScript, TanStack Start + TanStack DB + Electric (pre-1.0: pin
  versions), `@solana/kit`, pnpm 12.6, Node 24 (ADR 0013: exact dependency versions, move to 26 when Temporal and the host support it), **oxlint + oxfmt** (not ESLint/Prettier/Biome), vitest.
- **Ask before installing** any tool, crate or npm package, including `anchor build` the first
  time (it downloads crates).
- Load the `solana-dev` skill for Solana work. Check Squads, Kora, subscriptions and wallet APIs
  against current docs before using them — they change fast. Run the Solana program autofixer
  on any program code you write, before returning it.

## Engineering principles
- Small readable functions; KISS, DRY, YAGNI. Per-language rules: `~/.claude/guidelines/<language>.md`.
- Design before code: problem → constraints → options → ADR → threat model → invariants → tests →
  code. Failing tests come from the invariants (`docs/05-invariants.md`).
- Explain the security reasoning in PRs, not just the change.
- Diagrams: valid ```mermaid with an explicit type; ASCII only inside ```text.

## Working rules
- Plans only after the user says "confirm"; one PR per module with HLD/LLD and data models; pause
  after each PR for review.
- Git (once the repo exists): git-flow, PRs into `develop` with `--base develop`, squash;
  never commit to `main` or `develop` directly.
- Record each decision in `docs/adr/` and each session in `docs/BUILD-LOG.md` (what AI did, what
  the user changed, why).
- Public text (READMEs, PRs, posts) never contains the user's wallet addresses, balances or tx
  hashes. The guard hook enforces this for gh/git publishing.
- **TypeScript tests** live in a mirrored `test/` tree per package (not colocated): they need a real Postgres and shared helpers, and the layers (`domain`, `application`, `infrastructure`) are tested at different levels. This is the recorded exception to the global "colocate tests" rule.
- **SQL conventions** (from the PR 1 database review): every statement is a named constant in `infrastructure/pg/queries.ts` (tests reuse those, and keep test-only inspection and attack SQL in `test/support/sql.ts`; a scan test fails on inline SQL anywhere else); tables are always schema-qualified (`ledger.`); every PL/pgSQL function pins `SET search_path = pg_catalog, pg_temp`; every constraint has an explicit name; an app-level invariant ("X never mixes Y") must also be a database constraint, or the code says why it cannot be; rows read back are parsed with zod, never trusted through `query<T>()`; the TypeScript value lists and the SQL CHECK lists are tied together by a test.
- **Gates** before any PR: `pnpm run typecheck`, `pnpm run lint` (type-aware), `pnpm run format:check`, `pnpm test` (needs `docker compose up -d --wait`).
