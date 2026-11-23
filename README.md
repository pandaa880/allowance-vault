# Family Allowance Vault

Send a monthly USDC allowance to family, with rules they can see and you can trust: monthly caps,
spending categories, time-locked releases, a guardian for large claims, and receipts on Solana.
Family members don't need SOL to claim.

> **Status: pre-design skeleton (Oct 2026).** The program is still Anchor's template sample. The
> design is being written in public in [`docs/`](docs/README.md); code follows the design.
> Devnet only. The INR payout is a mock of a licensed partner; nothing here moves real money.

> **Scope v2+ (2026-11-20):** built deep in four slices: (1) paid exactly once, off-chain; (2) failure
> catalogue, FX and reversals; (3) real chain: Anchor program, wallet route, transaction landing,
> indexer; (4) product and hosted demo. Kora and SF `subscriptions` are backlog.

## How it will work (proposed)
A claim names one of two kinds of payout route, under the same caps, periods and guardian:
- **Wallet route:** the program checks the rules and sends USDC straight to the family member's
  wallet in the same transaction. Hosted devnet demo, test tokens only.
- **Partner route:** USDC goes to a mock licensed partner, which pays INR. A Temporal payout
  workflow, a Postgres double-entry ledger and a faulty mock partner sit behind it. Local
  `docker compose up` demo.
- The sender's funds sit in a **Squads smart account** or a program vault (D1, decided in slice 3).
- The `allowance_vault` program adds routes, guardian co-sign, claim records and receipts.
- Family members pay no fees: the hosted demo uses one rate-limited fee-payer function.
- Every release emits an event; the audit view shows the full history to both sides.

## Repo layout
```text
programs/allowance-vault/   Anchor program + Rust LiteSVM tests
app/                        web app (planned)
packages/                   generated client + shared UI (planned)
docs/                       problem, constraints, options, ADRs, threat model, invariants, build log
```

## Build and test
Requires Anchor CLI 1.2.1 and Solana CLI 4.3.x.

```sh
anchor build      # first run downloads crates
cargo test        # LiteSVM tests (Anchor.toml: test = "cargo test")
```

## How this is built
Design first, in public: each decision is an ADR in `docs/adr/`, and `docs/BUILD-LOG.md` records
what AI tools did and what was changed by hand. AI assistance is disclosed per session there.

## License
Apache-2.0 — see [LICENSE](LICENSE).
