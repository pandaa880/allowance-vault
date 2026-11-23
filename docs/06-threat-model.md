# 06 — Threat model

> Status: draft. Written before code; every mitigation points at an invariant (05) or an ADR.

| Threat | Asset at risk | Impact | Mitigation | Invariant / ADR |
|---|---|---|---|---|
| Family member's device phished | that member's allowance | up to one period's cap | caps, guardian above threshold, sender can pause | I2, I4 |
| Guardian key compromised | large claims | approvals for over-threshold claims | guardian alone can't release; needs a valid claim within caps | I2, I4 |
| Sender key lost | whole treasury | funds stuck | Squads multi-signer recovery `[ ]` | ADR |
| Over-claim via repeated requests | treasury | drain beyond cap | per-period accounting, idempotent claim ids | I2, I3 |
| Replay of an approved claim | treasury | double release | claim id consumed on release | I3 |
| Relayer fee drain (Kora) | relayer SOL | sponsor pays for spam or account creation | instruction allowlist, rate limits | I6 |
| Over-broad approval shown in wallet ("approve any amount") | sender's trust | sender approves more than intended | scoped delegation; see SF subscriptions #264 | ADR |
| Rule change front-running a claim | family / sender | rules changed mid-period | changes apply next period or after timelock | I5 |
| Clock / period boundary edge cases | treasury | double cap across boundary | single period function, tests at boundaries | I2 |
| Personal data leak | family privacy | identity linked on-chain | no PII on-chain | I8 |
| Owner pressured by a scammer (scenario B) | owner's savings | large payment to a scammer | new-payee delay, guardian above threshold, alerts | ADR (B) |
| Owner coerced to remove the guardian (B) | owner's savings | protections switched off | rule-change timelock + guardian alert | I5, ADR (B) |
| Guardian is the abuser (B) | owner's savings / autonomy | theft or permanent veto | guardian can't move funds or edit payees; veto expires after a longer delay | I11, ADR (B) |
| Payout mock trusted too much | INR leg | fake "paid" status | payout status is off-chain and labelled as such | I7 |

`[YOU: add threats you see; mark which ones v1 accepts as known risks]`
