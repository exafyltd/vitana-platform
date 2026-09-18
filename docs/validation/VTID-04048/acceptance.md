# VTID-04048 — Activate the Vertex Serbian voice bridge in production

## Reported / requested

Platform owner, in conversation, after VTID-04036 shipped to staging:
"publish to production". Investigated before acting rather than assuming
a routine promotion was safe.

## What was found

Production (`gateway.vitanaland.com`) was serving `7ba9a8e`, dated
2026-09-16 — 50 commits behind `main`/staging at the time, none of them
reviewed in this conversation. The Vertex Serbian bridge (VTID-04000,
VTID-04026, VTID-04036) had shipped to staging only; production had none
of it.

Attempted a scoped backport (branch `vertex-serbian-bridge-prod-backport`,
cherry-picking only the 3 bridge commits onto production's own live
commit, deliberately excluding ~47 unrelated commits from other sessions).
That branch built and tested clean locally (`tsc --noEmit`, 933 suites /
15,298 tests, plus 7 bridge-specific suites / 160 tests), but dispatching
`AWS-PROD-DEPLOY-GATEWAY.yml` against it failed at the very first step:

```
##[error]Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity
```

Root cause: `AWS_PROD_ROLE_ARN`'s IAM trust policy (documented in
`docs/AWS-PRODUCTION-BUILD-LOG.md`) is hard-scoped to
`token.actions.githubusercontent.com:sub =
repo:exafyltd/vitana-platform:ref:refs/heads/main` — the prod deploy role
can only ever be assumed when the workflow is dispatched against `main`.
No build mode (`promote-staging`, `rebuild-main`) can ship an isolated
commit set; every mode builds from whatever `main` or staging currently
is. This session's own AWS credentials carry an explicit IAM
permissions-boundary deny, so verifying or working around the trust
policy was not attempted.

Given that hard constraint, put the choice to the platform owner
directly (AskUserQuestion): merge the activation into `main` and promote
the full current staging build (the PUBLISH-button equivalent — all
already-tested, already-merged work goes live together), or wait for an
operator with IAM rights to widen the trust policy. The owner chose the
former, explicitly.

## What this VTID does

The bridge code was already on `main` (merged there directly by the
sessions that built VTID-04000/04026/04036 — this VTID does not touch
gateway source at all). The one missing piece was production's deploy
workflow: `AWS-PROD-DEPLOY-GATEWAY.yml` never wired
`GOOGLE_CLOUD_PROJECT`/`VERTEX_AI_LOCATION`/`VERTEX_SERBIAN_BRIDGE_ENABLED`/
`GCP_SERVICE_ACCOUNT_JSON`, so even a full promotion would have shipped
inert code. This PR adds that wiring, mirroring
`AWS-STAGE-DEPLOY-GATEWAY.yml`'s block byte-for-byte, including the exact
same `GCP_CRED_CONFIG` (Workload Identity Federation credential config)
value.

Confirmed live via `aws ecs describe-task-definition` (boto3, this
session's own AWS credentials) that prod's `vitana-gateway-awsdr` and
staging's `vitana-gateway` task definitions share the identical
`taskRoleArn` — `arn:aws:iam::472838866351:role/vitana-ecs-task-role`.
GCP's WIF trust binding authorizes that AWS role ARN, not a specific ECS
service, so the STS token exchange a running production task performs
resolves to the exact same trusted principal staging already uses. No
additional GCP-side grant was made or needed.

## Acceptance criteria

AC-1: production deploy workflow wires all 4 Vertex-bridge vars
unconditionally (no describe-secret, no if-guard), same GCP_CRED_CONFIG
value as staging, project id `project-da3eb05a-c86e-47cb-85f`, never
`lovable-vitana-vers1`.
TEST: services/gateway/test/orb/live/upstream/staging-vertex-serbian-bridge-wiring-pinned.test.ts
("is wired on prod, unconditionally, with the SAME GCP_CRED_CONFIG value
staging uses (VTID-04048)", "prod points at the same new GCP project —
never the decommissioned one")

AC-2: the workflow YAML still parses and the embedded bash still passes
this repo's own syntax check after the insertion (step 1/2 stays under
GitHub Actions' ~21,000-char per-step limit — measured 15,078 chars).
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
(pre-existing, re-run unmodified against the changed file)

AC-3 (post-merge): production actually serves the merged commit and
reports the bridge vars live.
CURL: see commands.log "AC-3" — `/api/v1/admin/build-info` on
`gateway.vitanaland.com` reports the merge commit after the promotion
dispatch completes.

## Not done here, flagged

- No real Serbian voice session was placed against production after
  activation — the bridge's actual behavior (Gemini Live answering, tool
  calls working) was already proven live on staging in VTID-04036's own
  evidence pack (6/6 sessions, 0×1007). This VTID only confirms the
  activation reached production's task definition.
- The IAM trust-policy restriction to `main` only is a standing
  constraint on every future scoped/out-of-band prod deploy from this
  session, not something this VTID changes. Flagging it here so it isn't
  rediscovered the hard way again.
