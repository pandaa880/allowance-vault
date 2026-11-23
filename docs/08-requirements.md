# 08 — Requirements (starting point, v2+)

> Status: **proposed, 2026-11-20.** Collected from the v2+ plan
> (`../../colosseum/PLAN-roles-projects-prep-2026-11.md` §3), `AGENTS.md`, ADRs 0001–0010 and the
> architecture reviews (R1–R21). Nothing here is confirmed until you say "confirm". Where a
> requirement depends on an unanswered question, it names the question (`OQ-nn`, in
> [09-open-questions](09-open-questions.md)). Architecture improvements come later; this file only
> writes down *what the system must do*.
>
> Words: **MUST** = needed for the slice to be "done"; **SHOULD** = wanted, cut first if late;
> **MAY** = nice to have. "Slice" = delivery step S1–S4 from the plan.

## 1. Purpose and scope
A sender abroad funds an allowance for family. Each payout follows rules the sender set, can need a
second person's approval, and ends with a receipt both sides can read. The project is a **technical
portfolio build** (CLAUDE.md: no business requirement, free-tier hosting only), shipped in four
slices that each end with something public.

**In scope:** off-chain ledger and payout workflow (S1–S2), on-chain claim program and indexer (S3),
product app and hosted demo (S4), two payout routes (wallet, partner).
**Out of scope:** real money, being a remittance provider, INR → stablecoin conversion inside India,
merchant-category enforcement, AI inside the product, Kora, SF Subscriptions, Seeker (backlog).

## 2. Actors
| Actor | Who | Can do | Must never be able to |
|---|---|---|---|
| Sender (owner) | NRI funding the allowance (scenario A) or a parent (scenario B) | Set rules, fund, change rules (delayed), pause, withdraw unclaimed funds | — |
| Family member (spender) | Receives money | File claims within rules | Exceed cap, pick a destination outside a registered route |
| Guardian | Trusted co-signer | Approve or reject large claims | Move funds, add routes, change rules, name their own replacement |
| Partner (mock) | Licensed payout partner stand-in | Quote, pay INR (simulated), send signed webhooks, sign receipts | Be trusted for anything but "INR arrived" |
| Operator | Us | Run services, rotate keys through the queue | Hold a key that moves user funds |
| Fee payer | Serverless function (hosted demo) | Pay network fees for this program's instructions | Move user funds, fund arbitrary accounts |
| Viewer | Sender or family on the Audit view | Read history and receipts | See data of another party's account |

## 3. Functional requirements

### 3.1 Setup and rules
| ID | Requirement | Slice | Source |
|---|---|---|---|
| FR-1 | The sender MUST create an allowance with: a spender, a per-period cap, a guardian threshold, and one or more routes. | S3 (S1 models it off-chain) | AGENTS, ADR 0001/0003 |
| FR-2 | A period MUST be a fixed 30-day window from a fixed anchor, half-open `[start, start+30d)`, computed by one function used by every check. Unused cap MUST NOT roll over. For the demo, the period length MUST be configurable (2-minute periods). | S3 | ADR 0005, plan §3 |
| FR-3 | Each route MUST have a kind: `WALLET`, or a partner kind (`AD_BANK_WIRE`, `RDA`, `MTSS`). A claim MUST name exactly one route; the route fixes the destination. | S3 | ADR 0003 update |
| FR-4 | Rule changes are classified. **Tightening** (lower cap, shorter period, remove payee, revoke key, pause) MUST apply at once and emit an event. **Loosening** (raise cap, add payee, add key, extend period, resume, remove guardian; a mixed change counts as loosening) MUST be queued, emit an event, be visible to everyone, apply after a delay of 1 day, mid-period (configurable per environment; minutes in the hosted demo), except removing the guardian, which waits 7 days, and be cancellable by the sender and by the guardian. The guardian MUST be able to undo a lockout instantly, restoring only the rule version in force before the first tightening of that lockout (never beyond it), with an alert to the sender. Pending claims on the old version MUST become `Cancelled` on apply. | S3 | ADR 0007 update 2026-11-23, `OQ-14` |
| FR-5 | Every parameter MUST be bounded when written (min/max). Each claim MUST record the rule version active when it was made, and a rule change MUST NOT rewrite a claim already released. (The earlier "later periods only" wording is replaced by FR-4's classes: loosening waits for its delay, tightening applies at once.) | S3 | AGENTS invariant 5, ADR 0007 update, `OQ-14` |

### 3.2 Claims
| ID | Requirement | Slice | Source |
|---|---|---|---|
| FR-6 | A family member MUST be able to file a claim: route, category, amount, opaque biller-reference hash. No PII on chain. | S1 (off-chain), S3 | ADR 0003, invariant 8 |
| FR-7 | A claim MUST be released at most once, however many times it is retried, re-delivered or re-signed. The binding from one user intent to one claim MUST be defined. | S1, S3 | invariant 3, R13, `OQ-02` |
| FR-8 | Claim ids MUST come from a per-spender counter that only goes up; closing a claim never frees its id. | S3 | invariant 13 |
| FR-9 | At most one claim MAY be pending per spender at a time. Several claims per period are allowed while their sum ≤ cap. | S3 | ADR 0005 |
| FR-10 | A claim exactly at the cap MUST pass; one minor unit more MUST fail. | S1, S3 | AGENTS (tests) |
| FR-11 | A claim above the guardian threshold MUST NOT release without guardian approval; below it, it releases without. | S3 | invariant 4 |
| FR-12 | Claim states: `Requested → Approved (above threshold only) → Released → PartnerConfirmed`; terminal `Rejected`, `Expired`, `Cancelled`, `PayoutFailed`. A `WALLET` claim ends at `Released`. Each transition has one handler that checks state, signer and recorded relationship, and names the broken rule in its error. | S1 (off-chain), S3 | ADR 0006 |

### 3.3 Guardian
| ID | Requirement | Slice | Source |
|---|---|---|---|
| FR-13 | The guardian's approval MUST bind: spender, route, amount, mint, period index, policy version, claim id, expiry. Changing any field voids it. | S3 | ADR 0004, R3 |
| FR-14 | A pending approval MUST expire on its own; nothing is auto-approved. | S3 | ADR 0004 |
| FR-15 | Scenario A: a guardian rejection is final. Scenario B: the owner MAY resubmit after a longer delay without the guardian (`OQ-15`). | S3 | ADR 0004 |
| FR-16 | Guardian rotation MUST go through the rule-change queue; a guardian MAY resign after a delay but never names a replacement. | S3 | ADR 0004 |

### 3.4 Exit and safety
| ID | Requirement | Slice | Source |
|---|---|---|---|
| FR-17 | The sender MUST be able to withdraw unclaimed funds to the registered account without the guardian, family, fee payer or our backend, from any state, including paused. | S3 | invariant 11, ADR 0008 |
| FR-18 | Level-1 pause (sender) MUST stop new claims and releases. Level-2 pause (upgrade multisig) is for program bugs and MUST expire on its own. Neither stops withdrawal. | S3 | ADR 0008 |
| FR-19 | The upgrade authority MUST be a named multisig, documented in the README. | S3 | ADR 0008 |

### 3.5 Partner route (off-chain depth)
| ID | Requirement | Slice | Source |
|---|---|---|---|
| FR-20 | A `PayoutWorkflow(claimId)` MUST run reserve → pay partner with a stable idempotency key → wait for webhook or poll → settle, or compensate. | S1 | plan §3 |
| FR-21 | The mock partner MUST be able to debit and then time out, and MUST sign its webhooks (HMAC). | S1 | plan §3 |
| FR-22 | After the partner times out following a debit, a worker retry MUST result in exactly one payout and a balanced ledger. Killing the worker mid-activity MUST also end with one payout. | S1 | plan §3, R4, R12, `OQ-01` |
| FR-23 | Fault catalogue, each a named test tied to an invariant: duplicate webhook, out-of-order webhooks, bad signature, 5xx then success, partner reverses after success, worker crash. | S2 | plan §3 |
| FR-24 | The partner MUST quote USDC→INR with an expiry. A quote that expires before the payout starts, or a rate that moves past the 1% tolerance before then, MUST hold the payout until the family re-confirms; after the payout starts on a valid quote the sender carries the move (`OQ-07`). Who absorbs the difference is recorded in an ADR. | S2 | plan §3, R17, `OQ-07` |
| FR-25 | A reversal after success MUST post refund entries and answer the ADR 0006 PayoutFailed question (does the refund restore the cap). | S2 | plan §3, R11, R16, `OQ-05` |
| FR-26 | Receipts: the partner's key signs `sha256(canonical receipt JSON)`; `CREDITED` needs a non-empty `partnerToken` (the bank reference stays at the partner, OQ-17). The UI says "sent to partner" until the signed receipt lands, then "partner confirmed". | S3 | ADR 0010 |
| FR-27 | A reconciliation job MUST compare ledger and partner statement (S2), then chain, ledger and partner (S3), and output a mismatch report. | S2, S3 | plan §3, R12 |

### 3.6 Wallet route (on-chain depth)
| ID | Requirement | Slice | Source |
|---|---|---|---|
| FR-28 | A `WALLET` route MUST pay USDC to the family wallet in the same transaction as the rule checks. It has no attester; the claim is final at `Released`. | S3 | ADR 0003 update |
| FR-29 | Every screen of the wallet route MUST say devnet · test tokens · not a real remittance product. A real India configuration MUST contain no `WALLET` route. | S4 | plan legal note |
| FR-30 | Transaction landing: track each signature until confirmed or its blockhash expires; rebroadcast the same signed transaction (never re-sign); set priority fees; state a position on durable nonces. | S3 | plan §3 |
| FR-31 | Devnet setup: verifiable build; our own 6-decimal test-USDC mint; Squads path tested on devnet, or shown on a Surfpool mainnet fork if devnet lags. | S3 | plan §3 |

### 3.7 Ledger and events
| ID | Requirement | Slice | Source |
|---|---|---|---|
| FR-32 | Double-entry ledger in Postgres: accounts plus journal entries, debits = credits per transaction, enforced in the database. | S1 | plan §3 |
| FR-33 | Ledger MUST be append-only: no UPDATE or DELETE on entries. Corrections are new entries. | S1 | plan §3 |
| FR-34 | An idempotency-key table MUST store the request hash; replaying a key with a different hash MUST be rejected. | S1 | plan §3 |
| FR-35 | Amounts MUST be integer base units (`bigint`): USDC 6 decimals, INR paise. No floats anywhere. | S1 | invariant 9 |
| FR-36 | A fake `ClaimReleased` event source MUST feed S1; the finalized-event indexer replaces it in S3. The workflow's input contract (delivery guarantees) MUST be stated (`OQ-03`). | S1, S3 | R14 |
| FR-37 | The indexer MUST read finalized events only, keep a cursor checkpoint, and be safe to re-run (idempotent ingest key `(signature, ix_index, event_index)`). | S3 | R6, architecture page |
| FR-38 | Every money-moving instruction MUST emit an event the audit view can read. | S3 | invariant 10 |

### 3.8 Product (slice 4, protected)
| ID | Requirement | Slice | Source |
|---|---|---|---|
| FR-39 | One TanStack Start app with four views: Sender, Family, Guardian, Audit. | S4 | plan §3 |
| FR-40 | Live claim status via TanStack DB + Electric. Each role MUST see only its own rows (`OQ-11`). | S4 | R19 |
| FR-41 | Pending states MUST be honest on both routes: submitted → confirmed → finalized; sent to partner → partner confirmed. Which actions may be shown optimistically is defined (`OQ-10`). | S4 | plan §3, R19 |
| FR-42 | Hosted wallet-route demo: three demo wallets made in the browser with a role switcher; "Fund demo" calls a rate-limited serverless function that mints test USDC and pays fees. What the single-browser demo does and does not prove MUST be stated on the page (`OQ-08`). | S4 | plan §3, R18 |
| FR-43 | Local partner-route demo: `docker compose up`, a fault panel (partner times out after paying, duplicate webhook, reverse after success, kill worker), CI badge, video. | S4 | plan §3 |
| FR-44 | Wallet connect, token-based design system, accessibility (keyboard, contrast, focus). | S4 | plan §3 |
| FR-45 | Scenario B clip (elder guardian blocks a scam payment) MAY be shown. | S4 | plan §3 |

## 4. Invariants (must hold at all times)
On-chain invariants I1–I13 are in [AGENTS.md](../AGENTS.md) and [05-invariants](05-invariants.md).
Off-chain invariants L1–L6 (proposed) are in `05-invariants.md`. Summary:

- **L1 paid at most once** · **L2 ledger balanced and append-only** · **L3 idempotency key replay
  with a different hash rejected** · **L4 money conserved as flows, per claim and per period** (wording decided `OQ-04`, ADR 0012 proposed) ·
  **L5 before release, a rate move past 1% or an expired quote never starts a payout without re-confirmation** · **L6 chain, ledger and
  partner agree, or the report names the mismatch.**

## 5. Non-functional requirements
| ID | Requirement | Notes |
|---|---|---|
| NFR-1 | **Correctness over speed.** No claim path may trade correctness for latency. | No latency targets are set yet (`OQ-16`). |
| NFR-2 | **No custody by us.** No server key can move user funds. | Invariant 1 |
| NFR-3 | **Durability of intent.** A crash at any point leaves the system recoverable to one consistent state. | R12; boundary of what is proven is stated (`OQ-12`). |
| NFR-4 | **Privacy.** No PII on chain; the Audit view MUST NOT expose another party's bank or personal data. | Invariant 8, R19 |
| NFR-5 | **Observability.** A non-terminal claim older than a threshold MUST be visible without anyone looking. | R21, `OQ-13` |
| NFR-6 | **Cost.** Free tiers only: Vercel free, Helius free RPC (about 1M credits/month, 10 RPS), devnet, local Temporal dev server and Postgres in Docker. | CLAUDE.md |
| NFR-7 | **Reproducible.** The partner route runs from one command (`docker compose up`); CI runs the failure catalogue. | FR-43 |
| NFR-8 | **Security hygiene.** Webhook signatures verified; webhook replay window defined; secrets never in the repo; public posts never contain the user's wallets, balances or tx hashes. | CLAUDE.md |
| NFR-9 | **Honest copy.** The chain proves the route and declared category and that the partner signed; it does not prove the real purchase or that INR arrived. | ADR 0003, 0010 |
| NFR-10 | **Legal framing.** Stablecoin leg offshore; INR only through a licensed partner (the partner here is a mock); not legal advice. | CLAUDE.md |
| NFR-11 | **Disclosure.** AI use per session is recorded in `docs/BUILD-LOG.md`; no AI inside the product. | CLAUDE.md |
| NFR-12 | **Code quality.** Small functions, KISS/DRY/YAGNI; TypeScript with oxlint + oxfmt; failing test first; one PR per module. | CLAUDE.md |

## 6. Constraints and assumptions
- Devnet only; the INR leg is simulated and every receipt says SIMULATED.
- TypeScript for the off-chain stack; Rust only for the Anchor program (and a possible later port).
- Temporal runs on the local dev server only; no hosted workflows.
- TanStack DB (1.0 RC) and the Electric collection (0.2.x) are pre-1.0: pin versions, fall back to
  TanStack Query if needed.
- Squads devnet deployment lags mainnet; the hybrid design (option 5) is unproven until tests 1–4 run.
- Soft phases, not deadlines: a slice ends when its "done when" is true. Cut order if late: shorten
  the S2 catalogue, then drop Squads (option 3). Never cut S4 or interview prep.
- Approvals needed before each install (Docker runtime, Temporal CLI, npm packages; later Anchor
  crates and TanStack/Electric).

## 7. Acceptance, per slice
| Slice | Done when |
|---|---|
| **S1 paid exactly once** | Timeout-after-debit test goes red → green: one payout, ledger balanced. Killing the worker mid-activity also ends with one payout. README with diagram, invariants (L1–L3), how to run; short video. ADRs 0011, 0012 written. |
| **S2 failure catalogue** | Catalogue green in CI; property tests (fast-check) hold L1, L2, L4 after every step; FX and reversal tests pass; reconciliation report demo; post drafted. |
| **S3 real chain** | A devnet claim flows end to end on both routes; LiteSVM properties for I2–I5 and I11–I13; D1 decided; reconciliation (chain ↔ ledger ↔ partner) clean; indexer replaces the fake source. |
| **S4 product** | Four views with live status; hosted wallet-route demo; local partner-route demo with fault panel; 2-minute product video; README complete (architecture, invariants, failure catalogue, how to run); portfolio entry. |

## 8. Traceability
| Area | Requirements | ADR / doc | Review findings |
|---|---|---|---|
| Idempotency | FR-7, FR-22, FR-34 | 0006, 0010 | R4, R12, R13 |
| Money correctness | FR-32–35, L1–L6 | 05-invariants | R9, R15 |
| Rules and periods | FR-2, FR-4, FR-5 | 0005, 0007 | R5 |
| Guardian | FR-11, FR-13–16 | 0004 | R3 |
| Routes | FR-3, FR-28, FR-29 | 0001, 0003 | R1, R2 |
| Exit and pause | FR-17–19 | 0008 | R8 |
| Events and indexer | FR-36–38 | architecture page | R6, R14 |
| FX and reversals | FR-24, FR-25 | 0006 (update) | R11, R16, R17 |
| App and demo | FR-39–45 | plan §3 | R7, R18, R19 |
| Operations | NFR-3, NFR-5 | — | R20, R21 |

## 9. Not yet specified (gaps)
These are not requirements yet because the answer isn't known. Each is an open question:
latency and throughput targets (`OQ-16`), data retention and deletion (`OQ-17`), supported token
programs and mints (`OQ-18`), claim and approval expiry lengths (`OQ-19`), mock-partner behaviour
contract (`OQ-20`), role onboarding and key recovery for family (`OQ-21`).
