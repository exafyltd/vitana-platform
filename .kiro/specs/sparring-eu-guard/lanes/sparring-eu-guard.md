---
lane: sparring-eu-guard
state: ready
next_actor: kiro
branch: claude/sparring-eu-guard/code
depends_on: []
executor: claude
seat: exafy
area: platform
repos: [exafyltd/vitana-platform]
reviewer_seat: exafyltd
updated: 2026-11-11T21:37Z
reviewer: exafyltd (exceptions seat; the reviewer agent is refused on claude lanes)
paths:
  - services/gateway/src/constants/llm-defaults.ts
  - services/gateway/src/services/plan-sparring/partner.ts
  - services/gateway/src/providers/bedrock.ts
  - services/gateway/test/plan-sparring/sparring-eu-guard.test.ts
  - services/gateway/test/providers/bedrock-region.test.ts
vtid: VTID-05762
---
# Lane sparring-eu-guard (C1–C3 of plan sparring-eu-guard)
Build C1, C2 and C3 exactly as the plan states. Red tests first on main, then the change. Nothing else.

### 2026-11-11T21:37Z · ci-plan-spar · ready (VTID allocated)
VTID-05762 allocated after policy approval (converged-auto-v1).
