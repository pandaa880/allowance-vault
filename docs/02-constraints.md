# 02 — Constraints

> Status: draft. Research notes, not legal advice. Confirm the legal points before any real use.

## Legal (India)
- **Keep the stablecoin leg offshore.** Move INR only through licensed channels: an RBI-authorised
  cross-border payment aggregator (PA-CB) or an authorised dealer bank, with an e-FIRA.
  Example of this pattern for fiat: https://www.xflowpay.com/press/xflow-compliant-stablecoin-acceptance
- **Never convert INR to stablecoins inside India.** Enforcement has targeted INR→USDT conversion
  (ED searches of Bengaluru firms, June 2026, press): https://voice.lapaas.com/ed-crypto-platforms-search/
- RBI opposes legalising crypto assets and pushes banks away from stablecoins (July 2026, press):
  https://www.thecoinrepublic.com/2026/07/06/crypto-regulation-news-rbi-pushes-banks-away-from-stablecoins/
- Residents holding crypto assets: 30% tax on gains + 1% TDS on transfers:
  https://incometaxindia.gov.in/w/taxation-of-virtual-digital-asset-vda-
- **Open question (ADR needed):** should a family member's wallet ever hold USDC? If it does, they
  hold a crypto asset in India (tax, compliance). Alternative: their key only *authorises* a claim,
  and the payout partner (offshore) pays INR. `[YOU: decide]`
  **v2+ (2026-11-20):** both exist as route kinds. The **partner route** is the real India shape
  (family never holds USDC). The **wallet route** pays USDC to the family wallet and is a devnet demo
  only (and scenario B). In a real India configuration no `WALLET` route exists.

## Custody
- We never hold keys that can move user funds. Funds stay in the sender's Squads smart account or
  a program-owned account governed by the sender's rules.
- The fee payer pays fees only. v2+: one rate-limited serverless function in the hosted demo; Kora
  is backlog.

## Users
- Family members are not crypto users: no SOL, no seed phrases if avoidable, plain-language
  approvals. `[YOU: embedded wallet / passkeys? decide in an ADR]`

## Cost
- Free tiers only: Vercel or Cloudflare Pages, Neon or Supabase free, Helius free RPC, devnet,
  Surfpool / LiteSVM locally, recorded demos instead of 24/7 servers.

## Scope
- Devnet only. Payout partner is a mock with the same message shape as a real one.
