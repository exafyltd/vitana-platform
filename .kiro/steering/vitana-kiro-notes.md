---
inclusion: always
---
# Working in Kiro on Vitana (VTID-05059)

- Kiro IDE has no Claude Code skills, hooks or subagents. The rules still apply unchanged:
  - **Plan sparring is never skipped.** Every plan is a `plan(<slug>)` PR; CI `PLAN-SPAR.yml` spars it (partner chain
    unchanged). Answer each round in `sparring/responses-<n>.md`. No VTID before convergence; CI allocates it.
  - The Claude Code PreToolUse sparring reminder and the SessionStart morning-pack hook do not run here. To load
    where a piece of work stands, run `scripts/dev/resume-vtid.sh <VTID>` from the vitana-platform checkout and paste its output into the chat.
- The always-included rules are the full `CLAUDE.md` (about 1,000 lines) — the same load a Claude Code session
  carries. Path-scoped references (`.claude/rules/*.md`) load only when you work on matching files.
- **Your role:** `.claude/rules/collaboration.md` §7 — Kiro runs the pipeline end to end (plan → CI sparring → CI VTID
  → build → reviewer agent → merge under §7b → staging → STAGING-VERIFY → Gate 2); Claude Code is optional (§7
  Claude-unavailable mode). What you never do: §7a (never allocate a VTID by hand, never deploy to production, never
  write to a live system from session tools, never accept your own lane). The entry point for every owner task is
  `.kiro/steering/vitana-pipeline.md`.
- **Collaboration (VTID-05145).** At the start of every session: generate your session id
  (`node <vitana-platform>/scripts/collab/queue.mjs session-id --agent kiro --seat <seat>`) and state it, with your
  lane; `git fetch --prune origin`; run the queue (`queue.mjs --repo <vitana-platform> --repo <vitana-v1>`) and work a
  lane whose `next_actor` is kiro after claiming it (`queue.mjs claim <slug>/<lane-id> --session <id>`). An approved
  plan is driven by one plan driver (§8). A plan you write is pushed as a PR — never left only in this chat. Full
  rules: `.claude/rules/collaboration.md`.
