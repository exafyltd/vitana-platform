---
lane: p5-rules
state: executing
next_actor: claude
vtid: VTID-05218
executor: claude
depends_on: [p1-plan-spar]
paths:
  - .claude/**
  - .kiro/steering/**
  - .kiro/automations/**
  - CLAUDE.md
  - scripts/collab/routine-prompt.md
  - .claude/skills/plan-sparring/**
updated: 2026-10-15T20:10Z
claimed_by: session_01J2m8CtCfCH4VEGqmp6HrDh
branch: ccr-ca63b286-optl8c
---
# P5 — rules, CLAUDE.md, Kiro automations and steering for the new roles (VTID-05218)

Plan: `.kiro/specs/pm-agent/plan-sparring.md` (plan block authoritative) · tasks: `tasks.md` section `p5-rules`.
Executor: Claude Code (governance paths). Start only when every `depends_on` lane is `done`.

## Log
### 2026-10-15T16:40Z · session_01J2m8CtCfCH4VEGqmp6HrDh · created → ready
Created with the plan (Gate 1 yes 2026-10-15).

### 2026-10-15T20:10Z · session_01J2m8CtCfCH4VEGqmp6HrDh · ready → executing
Rules for the new roles in both repos (collaboration §2, §3a, §5, §7, §7a, §8, §9; CLAUDE.md roles, Autonomy
Contract, rules 51/54), plan-sparring skill (CI path), both Kiro Web automations (planner / reviewer / builder,
one item per run), routine prompt (exceptions only).
