# 01 — Problem

> Status: draft. Replace the prompts with your own words; keep the sourced facts.

Two scenarios run on one program (decided 2026-11-11):
- **A, primary: India family allowance.** Everything below until "Scenario B".
- **B, second demo: US elder money guardian.** See the section at the end.

# Scenario A (primary) — India family allowance

## In one sentence
`[YOU: who is stuck, doing what, and what it costs them]`

## Who
- **Sender:** a person working abroad who supports family in India.
- **Family member:** a parent, sibling or student in India who receives money for expenses.
- **Guardian:** someone the sender trusts to approve large or unusual claims.

## Size and pain (sourced)
- India received a record **$135.46B** in inward remittances in FY25 (RBI data, reported by
  New India Abroad): https://www.newindiaabroad.com/news/indian-diaspora-sent-record-135-point-46-billion-dollars-home-in-fy25
- Average cost to send money to South Asia: **4.80%** (World Bank Remittance Prices Worldwide,
  Q1 2025): https://remittanceprices.worldbank.org/sites/default/files/rpw_main_report_and_annex_q125_1_0.pdf
- `[YOU: what the sender can't see or control today — lump sums, no rules, no receipts]`

## User stories (3–5 each)
Sender
- `[As a sender, I want … so that …]`

Family member
- `[As a family member, I want … so that …]`

Guardian
- `[As a guardian, I want … so that …]`

## Non-goals
- Moving real money, or acting as a remittance provider.
- Converting INR to stablecoins inside India.
- `[YOU: anything else out of scope for 4 weeks]`

## Success for the 4-week build
`[YOU: the demo that proves it works, e.g. "sender sets rules → family claims without SOL →
guardian approves a large claim → over-limit claim is rejected → receipt shows in audit view"]`

# Scenario B (second demo) — US elder money guardian

Same program, different roles: the parent owns and spends their own money; an adult child is the
guardian. No India leg, so no INR or FEMA questions; the payout partner becomes a US card issuer
or ACH bill-pay partner (mock).

## In one sentence
`[YOU: e.g. who gets pressured into sending money, and what stops it today]`

## Who
- **Owner:** an older parent in the US who pays their own bills.
- **Guardian:** an adult child (or sibling) who can approve, reject or delay, never move the money.
- **Attacker:** a scammer who pushes the owner to pay a new payee fast and in secret.

## Size and pain (sourced, check the primary report before public use)
- People 60+ reported about **$7.75B** in losses to the FBI's IC3 in 2025, up 59%; about $3.5B was
  investment fraud: https://www.ic3.gov/AnnualReport/Reports/2025_IC3Report.pdf (via
  https://www.investmentnews.com/ria-news/elder-fraud-complaints-surge-past-48-billion-as-investment-scams-lead-losses/260273)
- Existing tools are mostly one admin plus alerts (for example True Link's caregiver card: merchant
  category blocks, daily limits, alerts): https://truelinkfinancial.webflow.com/caregiver-card
- `[YOU: why urgency + secrecy is the scam pattern, and why a delay plus a second person breaks it]`

## User stories (3–5 each)
Owner
- `[As an owner, I want … so that …]`

Guardian
- `[As a guardian, I want … so that …]`

## Non-goals
- Real card issuing, real ACH, or holding anyone's money.
- Merchant-category enforcement (on-chain transfers carry no merchant codes; allowlisted payees
  are the on-chain stand-in).
- `[YOU]`

## Success for the demo
`[YOU: e.g. "owner pays an allowlisted bill instantly → scammer pushes a 5,000 USDC payment to a
new payee → held by the new-payee delay → guardian rejects → nothing moves → both see the audit"]`
