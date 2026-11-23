# 04 — Accounts and signers

> Status: diagram v1.1 draft (2026-11-11). Diagrams follow the proposed ADRs 0001–0010
> (`adr/README.md`), which are **not accepted yet**. v1.1 adds the payout adapter boundary (0001),
> route registry, rent reserve (0009) and withdrawal account (0008). D1: on the partner route family
> members never hold USDC; the vault pays only an allowlisted offshore partner. Fill the tables after
> the options ADRs. Post diagram v1 publicly, then each revision.
>
> **v2+ (2026-11-20), diagrams not redrawn yet:** (1) a second route kind, `WALLET`, pays USDC straight
> to the family wallet and is final at `Released`; (2) "Kora relayer" in the diagrams means the fee
> payer, a rate-limited serverless function in the hosted demo; (3) the payout worker is a Temporal
> workflow and the Postgres side is a double-entry ledger. Redraw in slice 3 with the program.

## Accounts
| Account | Owner program | Seeds | Size | Created by | Closed by |
|---|---|---|---|---|---|
| `[ ]` | | | | | |

## Who signs what
| Instruction | Signers | Writable accounts | Emits |
|---|---|---|---|
| `[ ]` | | | |

## Diagram v1 — architecture

Trusted: Squads program, this program's rules, the guardian's key. Untrusted: every client, the
Kora relayer, the indexer, the payout-partner mock, RPC.

```mermaid
flowchart LR
  subgraph Clients["Clients (untrusted)"]
    S[Sender app<br/>NRI, Squads member]
    F[Family app<br/>Phantom Connect email login]
    G[Guardian app]
    A[Audit view]
  end
  subgraph Infra["Infra (untrusted, free tier)"]
    K[Kora relayer<br/>pays fees only]
    I[Indexer<br/>Helius poll to Postgres]
    subgraph Adapter["Payout adapter boundary (0001)"]
      P[India adapter MOCK<br/>offshore licensed partner,<br/>attester key]
      US[US adapter<br/>scenario B, later]
    end
  end
  subgraph Chain["Solana devnet (trusted rules)"]
    SQ[Squads v4 treasury<br/>spending limit]
    subgraph AV["allowance_vault program"]
      POL[(Policy PDA<br/>cap, period, guardian,<br/>routes, version)]
      VLT[(Vault USDC account<br/>PDA owned)]
      CLM[(Claim PDAs<br/>state machine)]
      RT[(Route registry<br/>settlement account,<br/>attester key, kind)]
      RR[(Rent reserve PDA<br/>owner-funded SOL)]
    end
    PS[(Partner settlement<br/>USDC account, allowlisted)]
  end
  BANK[Licensed INR rail<br/>AD bank or RDA, simulated]
  FAM[Family bank account or biller]

  S -->|propose and approve| SQ
  SQ -->|set_policy, Squads signs| POL
  SQ -->|capped USDC top-up| VLT
  F -->|request_claim| K
  G -->|approve_claim| K
  K -->|sponsored tx| CLM
  CLM -->|release| VLT
  VLT -->|USDC only to a registered route| PS
  VLT -->|withdraw, registered account only| SQ
  RT -.->|fixes destination| PS
  RR -.->|claim rent| CLM
  CLM -.->|Released event| P
  P -->|INR payout| BANK --> FAM
  P -->|confirm_payout with receipt_hash| CLM
  AV -.->|events| I --> A
```

## Diagram v1 — end-to-end sequence

Example numbers only: cap 300 USDC per 30-day period, guardian needed above 100 USDC.

```mermaid
sequenceDiagram
  autonumber
  actor S as Sender (NRI)
  participant SQ as Squads treasury
  participant V as allowance_vault program
  actor F as Family member
  participant K as Kora relayer
  actor G as Guardian
  participant P as Payout partner (mock)
  participant I as Indexer and audit view

  Note over S,V: Setup, once
  S->>SQ: Propose create_policy (cap 300 USDC per 30 days, guardian above 100, routes)
  SQ->>V: Execute create_policy, Squads vault signs
  V-->>I: PolicyCreated event

  Note over S,V: Each period
  S->>SQ: Approve top-up
  SQ->>V: USDC into vault PDA, within Squads spending limit
  V-->>I: VaultFunded

  Note over F,P: Small claim, no guardian needed
  F->>K: Sign request_claim (school_fees, 80 USDC, biller ref hash)
  K->>V: Relay tx, Kora pays fee only
  V->>V: Check period index, cap, route, claim counter
  V->>P: Release 80 USDC to allowlisted partner settlement account
  V-->>I: ClaimReleased
  P->>P: Pay INR via licensed rail (simulated)
  P->>V: confirm_payout (claim id, receipt_hash), partner attester signs
  V-->>I: PayoutConfirmed
  I-->>S: Receipt with remittance ref
  I-->>F: Same receipt

  Note over F,G: Large claim, guardian co-sign
  F->>K: Sign request_claim (150 USDC, above threshold)
  K->>V: Relay
  V-->>I: ClaimRequested, needs guardian
  G->>K: Sign approve_claim (claim hash)
  K->>V: Relay
  V->>V: Hash binds amount, route, mint, policy version, expiry
  V->>P: Release 150 USDC
  V-->>I: ClaimReleased

  Note over F,V: Over the cap
  F->>K: request_claim 200 USDC (period total would be 430, cap is 300)
  K->>V: Relay
  V--xK: Error CapExceeded, no funds move
```

Not shown yet: `Rejected`, `Expired`, `Cancelled`, sender revoke and withdraw (invariant 11),
guardian rotation timelock (D3), policy version bump (D6). Next: claim lifecycle as
`stateDiagram-v2`.

## Scenario B (second demo) — US elder money guardian

Same program, different role mapping. Design rule: the program knows **owner**, **spender**,
**guardian** and **payee routes**, never "India" or "US"; the market lives in the payout adapter.

| Role | Scenario A, India (primary) | Scenario B, US elder |
|---|---|---|
| Funds owner | Sender (NRI) via Squads | Parent, own vault (single key or Squads) |
| Spender | Family member files claims | Parent pays own bills |
| Guardian | Independent co-signer above threshold | Adult child: approve, reject or delay; never moves funds or edits payees alone |
| Payout adapter (mock) | Offshore partner → licensed INR rail | US card issuer or ACH bill-pay partner |
| Spender holds USDC? | No (D1, proposed) | Yes, adult in the US, hidden behind the app |

```mermaid
sequenceDiagram
  autonumber
  actor M as Parent (owner)
  actor C as Adult child (guardian)
  actor X as Scammer
  participant K as Kora relayer
  participant V as allowance_vault program
  participant P as Bill-pay partner (mock)
  participant I as Indexer and alerts

  Note over M,V: Setup, once
  M->>V: create_policy (daily cap 300, guardian above 500, new-payee delay 72h, rule-change timelock 48h)
  C->>V: accept_guardian
  M->>V: add_payee (electric utility, pharmacy), active after delay
  V-->>I: PolicyCreated, PayeeAdded

  Note over M,P: Normal bill, allowlisted and under the cap
  M->>K: pay 120 USDC to electric utility
  K->>V: Relay tx
  V->>P: Release 120 USDC to the utility route
  P->>V: confirm_payout (receipt_hash)
  V-->>I: PayoutConfirmed
  I-->>C: Receipt (no action needed)

  Note over X,C: Scam attempt
  X->>M: Urgent call, "move 5,000 to a safe account now"
  M->>K: add_payee (unknown account) and pay 5,000 USDC
  K->>V: Relay
  V->>V: New payee pending 72h, amount above guardian threshold
  V-->>I: PaymentHeld (new payee, needs guardian)
  I-->>C: Alert
  C->>K: reject_payment (payment hash)
  K->>V: Relay
  V-->>I: PaymentRejected, no funds moved

  Note over X,V: Scammer pushes to remove the guardian
  M->>V: remove_guardian
  V-->>I: RuleChangeQueued, effective after 48h
  I-->>C: Alert, time to call the parent
```

**Open design tensions (ADRs needed, security reasoning):**
1. **Invariant 11 vs scams.** "Owner can always withdraw" is exactly the scam path. Proposal:
   owner withdrawal goes only to a pre-registered own account; anything else is a new payee with
   the delay and guardian rule.
2. **Guardian can be the abuser.** A relative guardian must never redirect or withdraw. Proposal:
   guardian can only reject or delay, and a rejected payment can be resubmitted after a longer
   delay without the guardian, so an active veto can't freeze the owner forever.
3. **Coerced rule changes.** Removing the guardian or raising caps goes through a timelock with an
   alert, not instant.
4. **Spender = owner in B, spender = beneficiary in A.** Model one `spender` role in the claim
   state machine so both scenarios share handlers.
