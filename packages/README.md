# packages (planned)

Created slice by slice (v2+ plan §3). Nothing is scaffolded yet.

| Package            | Slice | What                                                                                                                                                                                      |
| ------------------ | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ledger/`          | 1     | Postgres double-entry ledger: schema, migrations, idempotency-key table, posting functions. Integer base units (USDC 6 dp, INR paise).                                                    |
| `payout-workflow/` | 1     | Temporal (TypeScript) `PayoutWorkflow(claimId)`: reserve, pay partner with a stable idempotency key, wait for webhook or poll, settle or compensate.                                      |
| `mock-partner/`    | 1     | Mock licensed partner with HMAC-signed webhooks. Faults: debit then time out (slice 1); duplicate, out-of-order, bad signature, 5xx, reversal (slice 2); FX quotes with expiry (slice 2). |
| `events/`          | 1 → 3 | `ClaimReleased` event source: a fake source in slice 1, replaced by the finalized-event indexer in slice 3.                                                                               |
| `client/`          | 3     | Codama-generated `@solana/kit` client for `allowance_vault`, generated from the IDL and committed.                                                                                        |
| `ui/`              | 4     | Shared React components (amounts in base units, money formatting, light/dark tokens), if the app needs them.                                                                              |
