# Build log

One short entry per session or PR: the goal, what AI did, what was decided, and what was changed by
hand. Details live in the ADRs and plans. Newest first.

## 2026-11-26 — LiteSVM fix (PR 3) and ledger `Result` unions (PR 4)
- **Goal:** make the template LiteSVM test load SBPF v3 builds; return expected ledger refusals
  as values before the payout workflow uses the ledger.
- **AI (Claude Code):** traced `InvalidAccountData` to litesvm 0.10 vs SBPF v3 and bumped the test
  stack; redid PR 1b (the first local commit was lost with its worktree) with unit tests on a
  fake repository.
- **Decided (user):** redo 1b, split into two PRs, approve the litesvm 0.18.1 bump.
- **By hand:** `[YOU: what you reviewed or changed]`
- **Learned:** `[YOU: in your own words]`

## 2026-11-24 to 26 — Ledger package (PR 1, merged)
- **Goal:** build `packages/ledger`, the double-entry ledger behind slice 1.
- **AI (Claude Code):** set up the workspace and repo; wrote the ledger, its SQL schema and 188
  tests; ran independent reviews (Opus reviewers, a Postgres audit, DeepSeek via `pi`) and fixed
  their findings.
- **Decided (user):** `pg` with plain SQL migrations, and the schema hardening from the audits
  (ADR 0012 addenda); Node 24 with exact dependency versions (ADR 0013).
- **By hand:** `[YOU: what you reviewed or changed]`
- **Learned:** `[YOU: in your own words]`

## 2026-11-23 to 24 — Open questions answered, ADRs 0011 and 0012
- **Goal:** answer the blocking open questions before the payout and ledger ADRs.
- **AI (Claude Code):** explained how real payout partners behave (general knowledge, no partner docs
  checked); drafted ADRs 0011 and 0012; aligned requirements, invariants and ADRs 0007 and 0010.
- **Decided (user):** answers to OQ-01 to 05, 07, 14, 17 and 20 (in `09-open-questions.md`); a mock
  partner with strong and weak modes; ADRs 0011 and 0012 accepted.
- **Note:** the retention defaults (ledger 8 years) are not legal advice; a CA must confirm them.
- **By hand:** `[YOU: what you reviewed or changed]`

## 2026-11-20 — Architecture review of the v2+ design, requirements, open questions
- **Goal:** a written starting point: requirements, review findings and gaps to close.
- **AI (Claude Code):** wrote review findings R12–R21, `08-requirements.md` and
  `09-open-questions.md` (33 questions); checked one competitor (heirvault.xyz).
- **By hand:** `[YOU: which questions you answered and what you decided]`
- **Learned:** `[YOU: in your own words]`

## 2026-11-20 — Align project files with the v2+ plan
- **Goal:** make every note, README and ADR agree with the plan (four slices, two routes).
- **AI (Claude Code):** updated ADRs 0002, 0006, 0009, 0010, the READMEs, AGENTS.md, docs 02–05 and
  the architecture page. No code written.
- **Decided (user):** build deep in four slices (2026-11-17); two payout routes, FX and reversals,
  hosted devnet demo (2026-11-20).
- **By hand:** `[YOU: what you reviewed or changed]`

## 2026-11-13 — Squads Smart Account policy spike (code read)
- **Goal:** can allowance rules run inside a Squads Smart Account instead of our own vault?
- **AI (Claude Code):** read the Squads policy code (nothing built or run); wrote the spike note and
  added option 5 (hybrid) to ADR 0002.
- **Found:** no custom policy programs; hooks are the extension point, and our hook must bind its
  state to the smart account.
- **By hand:** `[YOU]`
- **Learned:** `[YOU: in your own words]`

## 2026-11-11 — Architecture and sequence diagram v1
- **Goal:** see the whole product before deciding D1–D6.
- **AI (Claude Code):** drew the architecture and sequence diagrams in `docs/04-accounts.md`;
  drafted ADRs 0001–0010 as proposed.
- **Decided (user):** India stays primary; a US elder money guardian is a second demo scenario.
- **By hand:** `[YOU: what you reviewed or changed]`
- **Learned:** `[YOU: in your own words]`

## 2026-10-31 — Repo skeleton
- **Goal:** set up the workspace and design-doc structure before any design decisions.
- **AI (Claude Code):** ran `anchor init`; wrote AGENTS.md, the README, tooling config and draft
  design docs from earlier research.
- **By hand:** `[YOU: what you reviewed or changed]`
