# 0013 — Node runtime and dependency versions

- **Status:** accepted
- **Date:** 2026-11-26

## Context
The off-chain packages run on Node. The skeleton (2026-10-31) picked Node 24 without a recorded
decision, three days after Node 26 became Active LTS. Separately, every dependency was declared
with `^`, and `@types/node` had been installed at 26 while the runtime was 24, which lets code that
uses Node 26-only APIs pass the type check and then fail at run time. For a money ledger,
dependency changes should be deliberate and reviewed.

Release status on 2026-11-26 ([Node.js releases](https://nodejs.org/about/releases/), checked
2026-11-26): Node 26 Active LTS since 2026-10-28, end of life April 2029; Node 24 Maintenance LTS
since 2026-10-20 (security fixes only), end of life April 2028. From Node 27 every major goes LTS.

## Options
1. **Node 26 now.** Newest LTS, longest support. Cost: the Temporal TypeScript SDK lists Node
   20, 22 and 24 as supported, not 26; the slice 4 host's Node 26 support is unchecked.
2. **Node 24 now, move to 26 later.** Officially supported by every planned package, including
   Temporal. Cost: maintenance-only until April 2028, so one migration within the project's life.

A spike on 2026-11-26 ran a real Temporal worker (SDK 1.26.0: native core-bridge, workflow bundling,
a durable timer and an activity) end to end on Node 26.13.1 and on Node 24.22.3, on macOS arm64.
Both worked with no warnings and with dependency install scripts blocked. Linux was not tested.

Planned packages (npm registry, 2026-11-26) need at most Node 22.15 (`@opentelemetry/sdk-node`);
TanStack Start and Vite need 22.12. None excludes 24 or 26.

## Decision
**Node 24** for all off-chain packages (`.nvmrc` 24, `engines` `>=24 <25`, `@types/node` 24.x), and
**exact dependency versions**: no `^` or `~` in any `package.json`, `saveExact: true` in
`pnpm-workspace.yaml`, the lockfile committed and installs run `--frozen-lockfile`. Dependency
install scripts stay off (`allowBuilds: false` for `@swc/core` and `protobufjs`).

## Consequences
- **Easier:** every planned package officially supports the runtime; an install can never move a
  version; a version change is always a visible diff in review (helps against supply-chain risk).
- **Harder:** upgrades are manual; Temporal's packages must be bumped together (they must share one
  version). Node 24 gets security fixes only, no new features.
- **Keeping the move to 26 cheap:** `@types/node` matches the runtime, so no Node 26-only API can be
  used by accident; `tsconfig` keeps `lib: ES2023`. Moving is then five config lines plus a
  reinstall. Note: Node 26's built-in `Temporal` (a date and time API) is unrelated to Temporal.io
  (`@temporalio/*`), the workflow engine used here.

## What would change this
Move to Node 26 when both hold: the Temporal TypeScript SDK lists Node 26 as supported, and the
chosen host supports Node 26 (check before slice 4). On the way, run CI on 24 and 26 for one cycle.
Upgrade earlier if Node 24 security support becomes a problem; it ends April 2028.
