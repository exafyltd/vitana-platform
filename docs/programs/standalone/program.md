---
id: standalone
title: Standalone work (specs outside the named programmes)
status: active
priority: 3
repos: [vitana-platform, vitana-v1]
specs:
  - vitana-platform:pm-agent
  - vitana-platform:claude-sessions-handover
  - vitana-platform:retire-claude-code
  - vitana-platform:plan-spar-stale-session
  - vitana-v1:chat-ux
  - vitana-v1:vitana-chat-markdown
  - vitana-platform:collab-kiro-governance
  - vitana-platform:kiro-primary-executor
  - vitana-platform:kiro-autonomy-fallback
  - vitana-platform:kaf-fallback-env
docs:
  - vitana-platform:.kiro/specs/pm-agent/plan-sparring.md
  - vitana-platform:.kiro/specs/claude-sessions-handover/handoff.md
  - vitana-v1:.kiro/specs/chat-ux/plan-sparring.md
  - vitana-v1:docs/validation/VTID-05193/plan-sparring.md
exit_criteria:
  - Every spec listed here is done or has moved to a named programme
next_review: 2026-10-22
---
# Standalone work

Programme registry entry (VTID-05215). Every current `.kiro/specs/*` spec belongs to exactly one programme; specs that
belong to none of the named programmes are listed here until the owner assigns them to one. Links only.

- `vitana-platform:pm-agent` — Project Manager Agent
- `vitana-platform:claude-sessions-handover` — handover of ongoing Claude Code sessions to Kiro
- `vitana-platform:plan-spar-stale-session` — PLAN-SPAR re-runs dead in_progress sparring sessions
- `vitana-v1:chat-ux` — chat UX
- `vitana-v1:vitana-chat-markdown` — Vitana chat replies render Markdown
- `vitana-platform:kiro-autonomy-fallback` — Claude Code optional; Kiro runs the pipeline end to end
- `vitana-platform:kaf-fallback-env` — fix-forward: the staging PM sees Kiro-fallback mode (VTID-05277)
