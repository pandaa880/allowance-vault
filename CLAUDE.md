@AGENTS.md

## Claude Code
- Private project notes are one level up (`../`): read `../HANDOFF.md` and the "Now" entry of
  `../TASKS-allowance-vault.md` before starting work.
- Load the `solana-dev` skill for program, client or wallet work.
- Git: repo is https://github.com/pandaa880/allowance-vault (git-flow, PRs into `develop`, squash). Never commit to `main` or `develop`.
- **Delegation (every agent, including subagents):** before starting a task, check whether the `delegate` skill fits and invoke it via the Skill tool when the task is simple and well-bounded (mechanical edits, read-only research, a standard single-PR module, test scaffolding from a written spec, or the user says delegate / hand off / run in background). Delegate with a written brief, an isolated worktree and a done-check, and report what was delegated and the done-check result. Do not delegate: ADRs and design decisions that need the user's answers, security- or crypto-sensitive work (ledger invariants, signing, partner receipts), unclear or cross-file work, installs.
