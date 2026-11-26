# Architecture decision records

One file per decision: `NNNN-short-title.md`, copied from [0000-template.md](0000-template.md).
Write it when you decide, not after. Superseded ADRs stay, marked "Superseded by NNNN".

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-market-neutral-program-payout-adapter.md) | Market-neutral program, payout adapter per market (India first) | proposed | 2026-11-11 |
| [0002](0002-where-funds-sit.md) | Where funds sit (D1) | proposed | 2026-11-11 |
| [0003](0003-categories-as-payee-routes.md) | Categories are payee routes, not merchant codes (D2) | proposed | 2026-11-11 |
| [0004](0004-guardian.md) | Guardian co-sign, binding and limits (D3) | proposed | 2026-11-11 |
| [0005](0005-periods.md) | Periods: fixed 30-day index from a UTC anchor (D4) | proposed | 2026-11-11 |
| [0006](0006-claim-lifecycle.md) | Claim lifecycle and one spender role (D5) | proposed | 2026-11-11 |
| [0007](0007-rule-changes.md) | Rule changes: versioned, queued, timelocked (D6) | proposed | 2026-11-11 |
| [0008](0008-exits-withdrawal-pause.md) | Exit paths: withdrawal account, pause, upgrade authority | proposed | 2026-11-11 |
| [0009](0009-fees-and-rent.md) | Who pays fees and rent | proposed | 2026-11-11 |
| [0010](0010-payout-receipts.md) | Payout receipts and partner attestation | proposed | 2026-11-11 |
| [0011](0011-off-chain-payout-architecture.md) | Off-chain payout architecture (Temporal workflow, mock partner, idempotency keys) | accepted | 2026-11-24 |
| [0012](0012-ledger-model.md) | Ledger model (double-entry, append-only, idempotency table, base units) | accepted | 2026-11-24 |
| [0013](0013-node-runtime-and-dependency-versions.md) | Node runtime (24 now, 26 later) and exact dependency versions | accepted | 2026-11-26 |

Planned after slice 1: FX quote expiry and who absorbs a rate move (slice 2); transaction landing
and durable-nonce stance (slice 3). v2+ notes (2026-11-20) are appended as "Update" sections to
0002, 0003, 0006, 0009 and 0010; the decisions stay proposed.
