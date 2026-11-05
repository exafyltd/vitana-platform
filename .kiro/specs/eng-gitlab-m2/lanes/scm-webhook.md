---
lane: scm-webhook
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-platform]
paths:
  - services/gateway/src/routes/internal-gitlab-webhook.ts
  - services/gateway/src/services/gitlab-events/**
  - services/gateway/src/types/cicd.ts
  - services/gateway/src/index.ts
  - services/gateway/test/routes/internal-gitlab-webhook.test.ts
  - services/gateway/test/gitlab-events/**
  - .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml
  - scripts/aws/setup-gitlab-webhook-secret.sh
  - docs/validation/**
claimed_by: kiro-exafy-202611041929-802c
branch: kiro/eng-gitlab-m2/scm-webhook
updated: 2026-11-05T00:29Z
vtid: VTID-05541
---
# Lane: scm-webhook (repo vitana-platform)
Tasks in `tasks.md`. Implements plan §3.5. The only lane that deploys (staging gateway); AWS-PROD-* is not touched. VTID from PLAN-SPAR; never by hand.

## Log
### 2026-11-03T19:40Z · kiro-exafy-202611021438-cff7 · ready
Lane created with the plan.

### 2026-11-04T19:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05541 allocated after policy approval (converged-auto-v1).

### 2026-11-05T00:29Z · kiro-exafy-202611041929-802c · ready → executing
Claimed; code, tests and evidence on branch kiro/eng-gitlab-m2/scm-webhook. Tests first: red on base with stub modules
(42 of 69 fail; `docs/validation/VTID-05541/outputs/red-on-base.txt`), green after (73). Route
`routes/internal-gitlab-webhook.ts` with the raw parser mounted before `express.json()`, mapper and dedupe under
`services/gitlab-events/`, the five topics in `CicdEventType`, the staging wiring step, the owner's copy script, and a local
curl proof. Decisions for Gate 2 are in `acceptance.md`. One known red: the atlas drift guard of
`test/vtid-04560-role-separation-regression.test.ts`, because no atlas domain claims the new route file and
`domain-atlas.ts` is outside this lane's paths. Lane `prerequisites` of plan agentic-delivery (PR #4684, in sparring) adds the
claim; this PR is brought up to date with `main` after it lands, and goes to review when every check is green.
