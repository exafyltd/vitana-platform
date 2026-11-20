---
lane: rules-v1
state: ready
next_actor: kiro
branch: claude/agentic-delivery-v2/rules-v1
depends_on: [rules-platform]
executor: claude
repos: [exafyltd/vitana-v1]
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - CLAUDE.md
  - AGENTS.md
  - .claude/rules/collaboration.md
  - .kiro/steering/vitana-pipeline.md
  - .kiro/steering/vitana-kiro-notes.md
  - .kiro/steering/vitana-owner-autonomy.md
  - .claude/hooks/pretooluse-plan-sparring-reminder.sh
updated: 2026-11-12T21:26Z
vtid: VTID-05711
seat: exafyltd
---

# Lane: rules-v1 (repo exafyltd/vitana-v1)

The same rule texts in vitana-v1; `collaboration.md` and `vitana-owner-autonomy.md` byte-identical to the platform copies.
Protected gate file `CLAUDE.md`: the owner's instruction of 2026-11-11 names this plan.

## Log
### 2026-11-11T12:00Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T11:27Z · ci-plan-spar · ready (VTID allocated)
VTID-05711 allocated after policy approval (converged-auto-v1).
### 2026-11-12T21:26Z · pm-agent · update
reassign lane →exafyltd (stale_ready, Claude unavailable)
