# Family Allowance Vault

Send a monthly USDC allowance to family, with rules they can see and you can trust: monthly caps,
spending categories, time-locked releases, a guardian for large claims, and receipts on Solana.
Family members don't need SOL to claim.

> **Status (Nov 2026):** slice 1 in progress. The off-chain ledger (`packages/ledger`) is built and
> tested; the Solana program is still Anchor's template. Devnet and test tokens only. The INR payout
> partner is a mock; nothing here moves real money.

## How it works
A claim names one of two payout routes, under the same caps, periods and guardian:
- **Wallet route:** the program checks the rules and sends USDC straight to the family member's wallet.
- **Partner route:** USDC goes to a licensed payout partner (mocked here), which pays INR. A payout
  workflow and a double-entry ledger make sure each claim is paid exactly once.

Funds stay with the sender in a Squads smart account, or in a program vault; that choice is made when
the on-chain part is built ([ADR 0002](docs/adr/0002-where-funds-sit.md)). Every release emits an
event, and an audit view shows the full history to both sides.

## Roadmap
1. **Paid exactly once** (off-chain): ledger, payout workflow, mock partner. In progress.
2. **Failure catalogue, FX and reversals.**
3. **Real chain:** Anchor program, wallet route, indexer.
4. **Product and hosted demo** on devnet.

## Repo layout
```text
packages/ledger/            double-entry Postgres ledger (built)
packages/payout-workflow/   Temporal payout workflow (next)
packages/mock-partner/      mock licensed payout partner (next)
programs/allowance-vault/   Anchor program (template until slice 3)
app/                        web app (slice 4)
docs/                       problem, options, ADRs, invariants, threat model, build log
```

## Build and test
The off-chain packages need Node 24, pnpm 12 and Docker:
```sh
pnpm install
docker compose up -d --wait    # test Postgres
pnpm test
pnpm run typecheck && pnpm run lint && pnpm run format:check
```

The Anchor program needs Anchor CLI 1.2.1 and Solana CLI 4.3.x:
```sh
anchor build      # first run downloads crates
cargo test        # LiteSVM tests
```

## How this is built
Design first, in public: each decision is an ADR in [`docs/adr/`](docs/adr/README.md). AI tools help
build it (there is no AI in the product); [`docs/BUILD-LOG.md`](docs/BUILD-LOG.md) records what AI
did and what was decided or changed by hand.

## License
Apache-2.0 — see [LICENSE](LICENSE).
