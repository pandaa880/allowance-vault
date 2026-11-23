# app (planned, slice 4)

One **TanStack Start** app with four views: **Sender** (fund, set rules, history), **Family** (claim,
request, receipts), **Guardian** (approve or reject) and **Audit** (events and ledger, readable by
both sides). Live claim status through TanStack DB + Electric (both pre-1.0: pin versions, fall back
to TanStack Query if needed).

Hosted demo (wallet route): three demo wallets made in the browser with a role switcher, a "Fund
demo" button calling a rate-limited serverless function that mints test USDC and pays fees, and
every screen labelled devnet · test tokens · not a real remittance product. The partner route runs
locally with a fault panel.

Not scaffolded yet: it's created in its own PR in slice 4. Ask before installing packages.
Tooling: TypeScript, `@solana/kit`, pnpm, oxlint + oxfmt, vitest.
