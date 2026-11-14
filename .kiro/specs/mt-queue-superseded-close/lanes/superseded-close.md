---
lane: superseded-close
state: ready
next_actor: kiro
depends_on: []
executor: claude
seat: hotmail
area: platform
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - scripts/collab/queue.mjs
  - scripts/collab/queue.test.mjs
  - docs/validation/VTID-*/**
updated: 2026-11-10T09:51Z
vtid: VTID-05676
---
# superseded-close — a plan may close when its parked lanes were superseded by done lanes
Plan: `.kiro/specs/mt-queue-superseded-close/plan.md`, `tasks.md` section `superseded-close`. **Held until PLAN-SPAR
allocates this lane's VTID.** `executor: claude` (protected gate file; the validator refuses `executor: kiro` for it);
built by Kiro seat `hotmail`, as `collab-handoff-check-fix/validator-fix` was. `scripts/collab/queue.mjs` is a protected
gate file: the merge needs the owner directive decision 3 (`docs/multitenancy/KIRO-HOTMAIL-DIRECTIVE-M0.md`) plus a
reviewer-agent accept on the current head.
Branch `kiro/mt-queue-superseded-close/superseded-close`; PR title `VTID-xxxxx (mt-queue-superseded-close/superseded-close): …`;
trailers `Collab-Session` and `Collab-Lane: mt-queue-superseded-close/superseded-close`.
## Log
### 2026-11-10T09:50Z · kiro-hotmail-202611061752-cc1f · created → ready
Created and held.

### 2026-11-10T09:51Z · ci-plan-spar · ready (VTID allocated)
VTID-05676 allocated after policy approval (converged-auto-v1).
