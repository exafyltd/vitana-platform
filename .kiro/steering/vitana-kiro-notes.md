---
inclusion: always
---
# Working in Kiro on Vitana (VTID-05059)

- Kiro IDE has no Claude Code skills, hooks or subagents. The rules still apply unchanged:
  - **Plan sparring is never skipped.** Every plan is a `plan(<slug>)` PR — never left only in this chat; CI
    `PLAN-SPAR.yml` spars it (partner chain unchanged). Answer each round in `sparring/responses-<n>.md`. No VTID
    before convergence; CI allocates it.
  - The Claude Code PreToolUse sparring reminder and the SessionStart morning-pack hook do not run here. To load
    where a piece of work stands, run `scripts/dev/resume-vtid.sh <VTID>` from the vitana-platform checkout and paste its output into the chat.
- The always-included rules are the full `CLAUDE.md` — the same load a Claude Code session carries. Path-scoped
  references (`.claude/rules/*.md`) load only when you work on matching files.
- **Your role — `.claude/rules/collaboration.md` §7–§7d on `origin/main` is the single source of truth.** You dispatch
  staging, verification and CI workflows, re-runs and owner-approved migrations yourself (§7d). Kiro runs the pipeline end to
  end: plans, builds and reviews (plan → CI sparring → CI VTID → build → reviewer agent → merge under §7b → staging →
  STAGING-VERIFY → Gate 2); Claude Code is optional (§7 Claude-unavailable mode). What you never do (§7a): allocate a
  VTID by hand (CI does), deploy to production except an owner-commanded publish (§7c: full, or one session's
  changes only), merge except under §7b, write to a live system (Supabase, AWS, gateway)
  from session tools, accept your own lane. The entry point for every owner task is
  `.kiro/steering/vitana-pipeline.md`; session start is in `vitana-load-project-rules.md`.
