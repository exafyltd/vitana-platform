---
lane: rules-platform
state: ready
next_actor: kiro
branch: claude/agentic-delivery-v2/rules-platform
depends_on: []
executor: claude
repos: [exafyltd/vitana-platform]
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - CLAUDE.md
  - AGENTS.md
  - .claude/rules/collaboration.md
  - .kiro/pipeline/common-rules.md
  - .kiro/pipeline/driver.md
  - .kiro/pipeline/planning.md
  - .kiro/pipeline/lane-code.md
  - .kiro/steering/vitana-pipeline.md
  - .kiro/steering/vitana-kiro-notes.md
  - .kiro/steering/vitana-owner-autonomy.md
  - .claude/hooks/pretooluse-plan-sparring-reminder.sh
updated: 2026-11-11T11:27Z
vtid: VTID-05710
---

# Lane: rules-platform (repo exafyltd/vitana-platform)

The rule texts of plan §18 in vitana-platform, each taking effect when the lane that builds its mechanism is on `main`.
Protected gate file `CLAUDE.md`: the owner's instruction of 2026-11-11 names this plan.

## Log
### 2026-11-11T12:00Z · kiro-exafyltd-202611111044-8f1d · ready
Lane created with the plan.

### 2026-11-11T11:27Z · ci-plan-spar · ready (VTID allocated)
VTID-05710 allocated after policy approval (converged-auto-v1).
