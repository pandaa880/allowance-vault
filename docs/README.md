# Design docs

Written in this order, before program code. Each doc is short; each decision becomes an ADR.

| Doc | Question it answers | Status |
|---|---|---|
| [01-problem](01-problem.md) | Who has what problem, how big is it? | draft |
| [02-constraints](02-constraints.md) | What must the design respect (legal, custody, cost)? | draft |
| [03-options](03-options.md) | What could we build on, and why pick one? | draft |
| [04-accounts](04-accounts.md) | Which accounts and PDAs, who signs what? | diagrams v1.1 |
| [05-invariants](05-invariants.md) | What must always be true about the money? | draft |
| [06-threat-model](06-threat-model.md) | What can go wrong, and what stops it? | draft |
| [07-compute](07-compute.md) | What does each instruction cost? | empty |
| [08-requirements](08-requirements.md) | What must the system do, per slice (FR/NFR, acceptance)? | proposed (2026-11-20) |
| [09-open-questions](09-open-questions.md) | What is still undecided, with the system design behind each? | 33 open (2026-11-20) |
| [adr/](adr/README.md) | Decisions, dated, with what would change them | 0001–0010 proposed; 0011 payout architecture and 0012 ledger model planned (slice 1) |
| [BUILD-LOG](BUILD-LOG.md) | What happened each session, incl. AI use | started |

"Draft" means starting notes from research, not decisions. Decisions are made in week 1 and
recorded as ADRs.
