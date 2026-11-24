---
lane: plan-spar-token
vtid: VTID-05833
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
protected_gate: two-model
paths: [.github/workflows/PLAN-SPAR.yml, scripts/collab/plan-spar-preview-token.test.mjs]
repos: [exafyltd/vitana-platform]
updated: 2026-11-24T16:45Z
---
# Lane: plan-spar-token
Paths and tasks: plan.md "Lanes" and tasks.md. VTID from CI PLAN-SPAR (or owner break-glass); never by hand.

### 2026-11-18T10:30Z · kiro-jtadic-202611180939-a2df · created

### 2026-11-19T12:35Z · kiro-jtadic-202611191115-a88f · ready (scope and marker, plan commit)
paths now name the workflow and its test; `protected_gate: two-model` (VTID-05765) added. The marker counts only from a
trusted revision (merge-base or a qualifying plan( PR, `queue.mjs` scopeCheck), never from a lane PR head. Owner
instruction for the protected file: recorded as "given in writing 2026-11-18" (artifacts/go-no-go.md B). Local lane
commit 3c4d6662af (2d30cf084b + one test case); non-binding pre-review on 2d30cf084b: changes (paths, marker), both
addressed here.

### 2026-11-24T16:45Z · kiro-jtadic-202611241634-913f · ready (owner instruction 2026-11-24, Rule 55 break-glass, VTID-05833)
Owner, 2026-11-24 (Kiro Web): "PLAN_SPAR_GATEWAY_TOKEN is now provisioned in GitHub Actions from the dedicated AWS
preview secret. Please take the prepared plan-spar-token workflow change through Rule 55 and the two required
independent reviews, then land it on main." This is the owner's instruction naming this plan for the protected file
`.github/workflows/PLAN-SPAR.yml` and the Rule 55 ruling for this lane. VTID-05833 comes from the GitLab
`vtid-allocate` operation (CLAUDE.md rule 2b, pipeline 1452 job 20592), not by hand. `depends_on` drops
`preview-ops`: that dependency only ordered the secret after the preview deploy (go-no-go.md C2), and the owner has
provisioned the secret. Covering sparring (Rule 55, plan.md §7b): the next full PLAN-SPAR run through the preview with
allocation off, after this lane is on main.
