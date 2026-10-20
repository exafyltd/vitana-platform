---
lane: ff-pm-flag
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
area: platform
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/services/project-manager/observe-live.ts
  - services/gateway/test/project-manager/observe-live.test.ts
  - docs/validation/VTID-*/**
updated: 2026-10-20T23:20Z
branch: kiro/kaf-fallback-env/ff-pm-flag
---
# ff-pm-flag — an unreadable `CLAUDE_AVAILABLE` repo variable falls back to the env; the 4 h rule stays
Plan: `.kiro/specs/kaf-fallback-env/plan.md` §3 and §5 B, and the `ff-pm-flag` section of `tasks.md`, are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Repo
vitana-platform. **Deploys** (gateway): ships `docs/validation/<VTID>/staging-tests.json` with the `/mode` ==
`kiro_fallback` check; done when STAGING-VERIFY passed on its merge commit (VTID-05277's suite included). Not a
protected gate file (`governance.ts` is not touched). Builds in parallel with `ff-stage-env`, merges after it. The
Project Manager gets the first merge attempt; after 30 min green with an accept on the head, the land step merges under
the owner instruction 2026-10-20 (plan §7) and records the finding. Seat `exafy` from `docs/programs/areas.yaml`
(`platform`). Shared files: none.
## Log
### 2026-10-20T23:20Z · kiro-exafyltd-202610202314-cfd9 · created → ready
Lane created with the plan (fix-forward of kiro-autonomy-fallback / VTID-05277). Next: PLAN-SPAR; once `vtid:` is set,
seat exafy claims it.
