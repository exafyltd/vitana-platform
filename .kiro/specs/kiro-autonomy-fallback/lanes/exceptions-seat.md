---
lane: exceptions-seat
state: ready
next_actor: kiro
depends_on: []
executor: claude
seat: exafy
area: platform
reviewer_seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - .kiro/automations/exafy.md
  - .kiro/automations/exafyltd.md
  - .kiro/automations/jtadic.md
  - scripts/collab/routine-prompt.md
  - scripts/collab/automations.test.mjs
  - docs/programs/areas.yaml
  - .kiro/pipeline/driver.md
  - docs/validation/VTID-*/**
updated: 2026-10-20T17:20Z
---
# exceptions-seat — Claude Routine jobs to seat exafyltd, automations as driver wake-ups, Kiro Web driver
Plan: `.kiro/specs/kiro-autonomy-fallback/plan.md` §3 and §5 E, and the `exceptions-seat` section of `tasks.md` are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here. Repo
vitana-platform. Deploys nothing. `driver.md` names the `plan-driver.mjs` CLI of lane `pipeline-speed` by its plan §4.7 /
§5 H contract only (text reference, no merge order). Other `.kiro/pipeline/*.md` files belong to `reviewer-agent`.
**Bootstrap (plan §6):** `executor: claude` is the value today's validator requires for `.kiro/automations/**`,
`scripts/collab/**` and `docs/programs/areas.yaml`; Kiro seat `exafy` builds it under the owner's §7b instruction.
Acceptance by `agent:vitana-lane-reviewer (claude-sonnet-5.5)`; review entry committed under the legacy `reviewer_seat`
exafyltd. Absorbs the automation-file edits of `retire-claude-code/rules-platform` and
`kiro-primary-executor/rules-platform-autonomy` (PR body lists which). Shared files: none.
## Log
### 2026-10-20T17:20Z · kiro-exafyltd-202610201618-c018 · created → ready
Owner instruction 2026-10-20: "no more approvals, you run it end to end" — §7b merge instruction for this plan's named
set, approvals from the reviewer agent on claude-sonnet-5.5; lands after `steering-rules`. Lane created with the plan.
Next: PLAN-SPAR; once `vtid:` is set, seat exafy claims it.
