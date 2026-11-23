# 03 — Options considered

> Status: draft. Fill "Verdict" after checking each option against current docs. Each pick becomes
> an ADR.
>
> **v2+ (2026-11-20):** "Monthly pull" (SF `subscriptions`) and "Fees for family" (Kora) are backlog;
> the hosted demo uses one rate-limited fee-payer function. "Where funds sit" is decided in slice 3.
> "INR payout" is now a mock partner route next to a devnet wallet route (ADR 0003 update).

| Decision | Option A | Option B | Option C | Verdict |
|---|---|---|---|---|
| Where funds sit | Squads smart account + spending limits | Our own vault PDA | Plain token delegation to our program | `[ ]` — 2026-11-13 spike adds option D: Squads Smart Account policies + our post-hook (see ADR 0002) |
| Rules Squads lacks (categories, time locks, guardian, receipts) | Own Anchor program alongside Squads | Encode in off-chain policy | Wait for Squads Policy Network | `[ ]` |
| Monthly pull | SF `subscriptions` program | Own crank instruction | Sender tops up manually | `[ ]` |
| Fees for family | Kora relayer | Session keys | Sender prefunds SOL to family | `[ ]` |
| Family wallet | Phantom Connect | Embedded wallet / passkeys | Plain keypair in app | `[ ]` |
| Token program | SPL Token (USDC today) | Token-2022 | Support both | `[ ]` |
| Receipts | Program events + indexer | Receipt accounts | Compressed NFTs | `[ ]` |
| Period boundaries | Unix time from `Clock` | Slots | Sender-set epochs | `[ ]` |
| INR payout | Mock partner service | Bill-pay mock (BBPS-shaped) | Skip for v1 | `[ ]` |

## Notes per decision
For each row: what each option costs, what it rules out, which invariant it touches, and the
source you checked (link + date). `[YOU]`

## Known references to check
- Squads smart account program: https://github.com/Squads-Protocol/smart-account-program
- SF subscriptions: https://github.com/solana-foundation/subscriptions (see issue #264 on wallet warnings)
- Kora: https://github.com/solana-foundation/kora (accepted issues #661, #720, #733)
