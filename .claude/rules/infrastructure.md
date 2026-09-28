---
paths:
  - .github/workflows/**
  - scripts/aws/**
  - scripts/deploy/**
  - docs/AWS-*.md
---

# Infrastructure reference — vitana-platform

Moved verbatim out of `CLAUDE.md` (pure relocation, section
numbers/content unchanged) so a session that never touches a deploy
workflow or an AWS script doesn't force-load GCP-decommission history,
AWS production topology, environment-variable reference, and deployment
protocol detail. VTID governance (§4) and the no-production-write posture
stay in the root `CLAUDE.md`, unscoped, because those must apply
regardless of which files a session happens to open in a given turn.

---

## 1. GCP INFRASTRUCTURE — DECOMMISSIONED (2026-08-16), DO NOT USE

**GCP is fully off.** Project `lovable-vitana-vers1` had billing disabled
2026-08-16 and the GCP `gateway` Cloud Run service was deleted the same
night (VTID-03599/VTID-03649 emergency response, prompted by the Gemini
cost incident chain in §2b's history). No process — OASIS, autopilot,
agents, Cloud Run, Cloud Scheduler, Cloud Build, Artifact Registry — runs
on GCP any more. There is no rollback path back to GCP; AWS (§1b) is the
only cloud. `gcloud`/Cloud Run/Artifact Registry commands that used to live
in this section are gone — do not run them, they will fail against a
disabled-billing project. If you find a live reference to
`lovable-vitana-vers1`, `us-central1`, `pkg.dev`, `gcr.io`, or a
`*.run.app` URL anywhere (a workflow, a task def, a script default), treat
it as dead code to be removed on sight, not as a fallback target.

---

## 1b. AWS PRODUCTION (VTID-03398, VTID-03409, VTID-03410, VTID-03411, VTID-03414, VTID-03415, VTID-03419, VTID-03599/VTID-03649)

**AWS is canonical production for every Vitana service.** gateway and
community-app were cut over first, as sole production, under **VTID-03419**
(2026-07-27; DNS execution record in `docs/AWS-CUTOVER-RUNBOOK.md` §3).
Every other service in the table below was built as parallel/DR
infrastructure under the VTIDs listed and became the **only** production
once GCP billing was disabled 2026-08-16 (VTID-03599/VTID-03649) — there is
no GCP instance left to be "the canonical one" instead. A new AWS resource
not listed in the table below still needs its own VTID.

| Service | VTID | ECS resource / dispatch | Public URL / access | Deploy workflow |
|---|---|---|---|---|
| gateway | VTID-03398 | ECS service `vitana-gateway-awsdr`, task def family `vitana-gateway-awsdr`, target group `vitana-tg-gateway-awsdr` | `https://dr-gateway.vitanaland.com` (ALB host rule, priority 5) | `AWS-PROD-DEPLOY-GATEWAY.yml` |
| community-app (frontend) | VTID-03409, cut over to sole production VTID-03419 | ECS service `vitana-community-app-awsdr` (now serving `vitanaland.com` apex + `www`, not just the `dr-app` DR hostname), target group `vitana-tg-community-awsdr` | `https://dr-app.vitanaland.com` (ALB host rule, priority 6) **and** `https://vitanaland.com` (apex/`www`, since VTID-03419 — routed via a Cloudflare Worker whose origin was repointed at cutover time, not by DNS alone, see runbook §3.2); static SPA build bakes the canonical gateway URL (`gateway.vitanaland.com`, itself AWS since VTID-03419) into `.env.production` — no runtime env var to flip | `AWS-PROD-DEPLOY-FRONTEND.yml` (in `exafyltd/vitana-v1`) — still on static `AWS_STAGING_ACCESS_KEY_ID`/`SECRET` repo secrets, not yet OIDC (follow-up) |
| oasis-operator | VTID-03410 | ECS service `vitana-oasis-operator-awsdr` (256 CPU/512MB, stateless, no DB dependency), target group `vitana-tg-oasis-op-awsdr` | `https://dr-oasis-operator.vitanaland.com` (ALB host rule, priority 7) | `AWS-PROD-DEPLOY-OASIS-OPERATOR.yml` — first CI/CD path this service has ever had; its source didn't exist in git and was restored from a stale `.backup` snapshot |
| oasis-projector | VTID-03411 | ECS service `vitana-oasis-projector`, fixed `desiredCount` — **no autoscaling**, the Ledger Writer has no cross-instance locking | No public ALB/DNS — internal DB reconciliation loop; verify via ECS `healthStatus` (`/ready`) | `AWS-PROD-DEPLOY-OASIS-PROJECTOR.yml` |
| worker-runner | VTID-03411 | ECS service `vitana-worker-runner`, fixed `desiredCount` | No public ALB/DNS — polls outward to gateway; verify via ECS `healthStatus` (`/alive`) | `AWS-PROD-DEPLOY-WORKER-RUNNER.yml` |
| verification-engine | VTID-03411 | ECS service `vitana-vitana-verification-engine`, fixed `desiredCount` | No public ALB/DNS — self-registers heartbeat outward; verify via ECS `healthStatus` (`/health`) | `AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml` |
| orb-agent | VTID-03414 | ECS service + task def family `vitana-orb-agent` — **pre-existing** from the unexplained 2026-07-09 bulk-provisioning event; this VTID added the missing deploy pipeline on top | No public ALB/DNS — outbound to LiveKit Cloud; verify via ECS `healthStatus` (`/alive`) | `AWS-PROD-DEPLOY-ORB-AGENT.yml` |
| autopilot-executor | VTID-03415 | No ECS service — one-shot task. Task def family `vitana-autopilot-executor`, dispatched per-execution via `ecs:RunTask` from `dispatchExecutorJobAws()` (`services/gateway/src/services/aws-ecs-admin.ts`), selected by `DEV_AUTOPILOT_JOB_CLOUD=aws\|gcp` env var — **must be `aws`**; the `gcp` branch is dead code left over from the dual-cloud period and will fail (no GCP job runner exists any more) | N/A — no long-running service to curl | `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` — build+push+register only, no service to roll; the next RunTask dispatch picks up the new `:LATEST` revision automatically |

Shared infra across all of the above:

| Item | Value |
|---|---|
| AWS account / region | `472838866351` / `eu-central-1` |
| ECS cluster | `Vitana-ECS-Cluster` (shared with AWS staging) |
| Database | RDS Aurora PostgreSQL `vitana-aurora-prod` (writer/reader) — DMS-replicated from the same Supabase-hosted Postgres project used pre-cutover (`inmkhvwdcuyhnxkgfvsb`). **This is not a Supabase→Aurora application cutover** — see §3 for the actual current state, which the code does not yet fully match this table's aspirational framing. |
| Redis | ElastiCache `vitana-redis-prod` |
| ALB | `vitana-alb-prod` — all host-header rules sit **below** priority 10 (see hard rule below) |
| Deploy auth | GitHub OIDC federation, `AWS_PROD_ROLE_ARN` (all except community-app's frontend workflow — see its row above) |
| Deploy trigger | Every `AWS-PROD-DEPLOY-*.yml` is `workflow_dispatch`-only, required `reason`, never on push |
| Command Hub PUBLISH target | `PUBLISH_TARGET_CLOUD` (gateway env var, VTID-03420) **must be `aws`** — `gcp` is dead, there is no GCP target left to promote to. When `aws`, PUBLISH promotes **AWS staging → AWS prod**: `POST /publish` resolves the commit `vitana-gateway` staging actually serves (HTTP build-info, never ECS status) and dispatches `AWS-PROD-DEPLOY-GATEWAY.yml` in `promote-staging` mode with `expected_commit` pinned — the exact tested ECR image ships, no rebuild. `/operator/revisions` for the gateway rows is likewise build-info-backed. `GCP_DUAL_PUBLISH_ENABLED`/`AWS_DUAL_PUBLISH_ENABLED` were dual-cloud-period flags for refreshing/dispatching a GCP leg alongside AWS — **both are now no-ops to leave on; turn them off**, there is no GCP leg left to refresh. |

**Secrets intentionally deferred (2026-07-24):** `ANTHROPIC_API_KEY` and
`OPENAI_API_KEY` are not populated in AWS Secrets Manager pending an AWS
sponsorship decision for Anthropic — GitHub tokens, Supabase, and DB
credentials are live. Task definitions that would reference these two
secrets have them omitted rather than pointed at an empty value (an empty
secret fails ECS provisioning with `ResourceInitializationError` before
the container starts) — see `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml`'s
header comment for the concrete example.

**Full build record, exact commands, and pre-existing-state findings:**
`docs/AWS-PRODUCTION-BUILD-LOG.md`.

**The GCP→AWS cutover this section used to gate is complete and irreversible** —
GCP billing is off, so there is no rollback target and no further sign-off
needed to treat AWS as canonical. `docs/AWS-CUTOVER-RUNBOOK.md` (VTID-03412)
is now a historical record of how the cutover was executed, not a
still-open checklist.

### Hard rules specific to AWS prod

- **Never** deploy to AWS prod on push — `AWS-PROD-DEPLOY-GATEWAY.yml`
  has no `on: push` trigger. Prod only moves via the Command Hub PUBLISH
  button or `publish-to-prod.sh`, both `workflow_dispatch`, never push.
- **Never** confuse `vitana-gateway` (AWS staging) with
  `vitana-gateway-awsdr` (AWS prod) — same ECS cluster, similarly named.
  The ALB target group named `vitana-tg-gateway-prod` actually serves
  **staging** — verify via `/api/v1/admin/health`'s `env` field, never by
  resource name. IaC lives in the private `exafyltd/vitana-infra` repo,
  whose own README says **"DO NOT terraform apply YET"** (checked-in state
  is stale vs. live infra) — see `docs/AWS-CUTOVER-RUNBOOK.md` §1 before
  ever running `terraform plan`/`apply` there.
- **Never** confuse the bare `vitana-community-app`/`vitana-oasis-operator`
  ECS services with the real, ALB-fronted
  `vitana-community-app-awsdr`/`-staging`/`vitana-oasis-operator-awsdr` —
  same name-collision trap as gateway above, except the bare-named ones
  are **not staging**, they're 2026-07-09 mystery-provisioning orphans
  (see the roster below) with zero ALB/service-discovery attached at all.
- **IF** adding a host-header listener rule to `vitana-alb-prod` →
  **THEN** give it priority < 10 — the existing path-based rules (`/api/*`,
  `/ws/*` at priority 10) match before higher-numbered host-header rules
  regardless of `Host`, and will silently route to staging otherwise.
- **Never** assume a service not in the §1b table has AWS infrastructure,
  or that a live AWS resource is governed just because it exists —
  `orb-agent`'s ECS service/task-def predated its own deploy pipeline
  (2026-07-09 bulk-provisioning event, exactly **27 ECS services** created
  in the same 3-second window — 4 later got a CLAUDE.md §1b entry and a
  deploy pipeline the same way `orb-agent` did, **23 remain fully
  undocumented**). **That 23-service roster is now named and classified**,
  not just estimated at "~17-22" — see
  `docs/AURORA-MIGRATION-STATUS-2026-09-10.md`'s 2026-09-11 addendum for
  the complete list, of which four
  (`vitana-auth-proxy`, `vitana-dev-console-ui`,
  `vitana-github-sync-service`, `vitana-mcp-gateway`) are confirmed fully
  dormant vs. which seventeen are alive and running real workloads with no
  external ingress path, and what is and isn't established about what the
  latter group actually does.
  Check for a matching `AWS-PROD-DEPLOY-*.yml` before trusting a running
  service reflects `main`; extending to a new service needs its own VTID.
- **Never** autoscale `oasis-projector`, `worker-runner`, or
  `verification-engine` — `oasis-projector`'s Ledger Writer has no
  cross-instance locking. Fixed `desiredCount` is deliberate.
- GitHub OIDC federation (no static AWS keys) is required for prod
  deploys — never add a static-key IAM user the way AWS staging did.
  community-app's frontend workflow is a documented, temporary exception.

---

## 8. ENVIRONMENT VARIABLES

### Required for Gateway
```bash
PORT=8080
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE=xxx
GITHUB_SAFE_MERGE_TOKEN=xxx
```

### Governance Controls
```bash
AUTOPILOT_LOOP_ENABLED=true|false
VTID_ALLOCATOR_ENABLED=true|false
```

### Optional
```bash
NODE_ENV=production|development|test
# Command Hub PUBLISH-button frontend promotion (exafyltd/vitana-v1). Without it,
# gateway still publishes; response reports frontend_promote.ok=false.
FRONTEND_DEPLOY_TOKEN=<PAT with actions:write on exafyltd/vitana-v1>
FRONTEND_DEPLOY_REPO=exafyltd/vitana-v1
# Must be 'aws' — 'gcp' is dead dual-cloud-period code (VTID-03420).
PUBLISH_TARGET_CLOUD=aws
# Amazon Polly / Titan / Bedrock — see §2b/2c/2d. Must be set explicitly;
# the code's own fallback is still 'google'/'vertex', both dead (GCP is off).
TTS_PROVIDER=polly
TTS_POLLY_STRICT=true
# Fish Audio TTS fallback for languages Polly has no voice for (sr, etc.) —
# see §2c-fish. Off/unconfigured by default; both must be set to activate.
TTS_FISH_FALLBACK_ENABLED=true
FISH_API_KEY=xxx
IMAGE_PROVIDER=bedrock
BEDROCK_ROLE_ARN=xxx
# Partner-org invite emails over Resend (VTID-04463). Off by default; all three
# must be set. EMAIL_FROM must be on a domain verified in Resend. Unset = the
# invite is created and the route returns accept_url for manual sharing.
PARTNER_INVITE_EMAIL_ENABLED=true
RESEND_API_KEY=xxx
EMAIL_FROM="Vitanaland <noreply@vitanaland.com>"
# Partner terms version in force for the onboarding engine (VTID-04478). Unset =
# no terms published: POST /partner-onboarding/:orgId/terms/accept answers 503
# and no org can submit. Set it only once the terms text is published.
PARTNER_TERMS_VERSION=2026-09
# Jev (TypeSafe System One) typed decisions (VTID-04473). Both must be set;
# unset = every decision answers 503 not_configured. Staging wires them when
# vitana/gateway/staging/typesafe-api-key exists. JEV_COMMUNITY_ENABLED stays
# unset until community cost control exists (owner decision 2026-09-25).
JEV_DECISIONS_ENABLED=true
TYPESAFE_API_KEY=xxx
VERTEX_LIVE_UNAVAILABLE=true
OPENAI_API_KEY=xxx
# Serbian-only Vertex Live bridge on a NEW GCP project — see
# §2e-vertex-serbian-bridge (VTID-04000). Off/unconfigured by default;
# GOOGLE_CLOUD_PROJECT/VERTEX_AI_LOCATION must point at the NEW project,
# never lovable-vitana-vers1 (permanently decommissioned).
VERTEX_SERBIAN_BRIDGE_ENABLED=true
GOOGLE_CLOUD_PROJECT=<new-project-id>
VERTEX_AI_LOCATION=us-central1
GCP_SERVICE_ACCOUNT_JSON=xxx
# Byte budget for the tool catalog the Vertex bridge declares (VTID-04026,
# §2e-vertex-serbian-bridge). Unset = 48 KB default; 0 disables the guard.
VERTEX_TOOL_CATALOG_BYTE_BUDGET=49152
# Operator Console machine-to-machine auth (VTID-04133) — lets a CI/test
# harness pass the VTID-03851 exafy_admin gate on POST /api/v1/operator/chat
# without a human password, via a dedicated 'X-Operator-Machine-Token'
# header (never Authorization). Off/unconfigured by default; both must be
# set to activate. Provision the token with
# scripts/aws/setup-operator-machine-auth-secret.sh — staging only, no
# product reason to ever set this on prod.
OPERATOR_MACHINE_AUTH_ENABLED=true
OPERATOR_MACHINE_AUTH_TOKEN=xxx
# Auto-dispatch of member bug / ux_issue tickets with a real spec to Dev
# Autopilot, no Approve & Fix click (VTID-04333, owner decision 2026-09-23).
# Exact 'true' enables; kill switch + PR-approval hold still apply. Pinned on
# staging only; off-switch is 'false'.
FEEDBACK_AUTO_DISPATCH_ENABLED=true
# Member-ORB support specialist (VTID-04397, orchestrator P3 agent-as-tool):
# read-only findings from the member's own tickets + the knowledge base via
# delegate_to_agent. Exact 'true' enables; unset = not registered, not declared.
ORCHESTRATOR_SUPPORT_SPECIALIST_ENABLED=true
# Business-ORB commerce onboarding specialist (VTID-04400, orchestrator P3):
# read-only findings about the caller's own partner organizations. Exact
# 'true' enables; unset = not registered, not declared.
ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED=true
# Delegation jobs written through to the agent_runs ledger (VTID-04415), so a
# specialist's result survives a gateway task change. Exact 'true' enables;
# unset = in-memory only, as before. Fail-open.
ORCHESTRATOR_DELEGATION_PERSIST_ENABLED=true
# Dev Autopilot run leases on the agent_runs ledger (VTID-04446, P4): the
# running-watchdog asks the lease instead of the 20-min clock. Exact 'true'
# enables; set on the gateway AND the executor task; apply migration
# 20260923210000_vtid_04446_run_leases.sql first. TTL clamps to 2-30 min.
ORCHESTRATOR_RUN_LEASE_ENABLED=true
ORCHESTRATOR_RUN_LEASE_TTL_MS=300000
```

`GOOGLE_CLOUD_PROJECT`, `GCP_PROJECT`, `VERTEX_LOCATION`, `VERTEX_MODEL`,
`GEMINI_API_KEY` were removed from this list 2026-08-18 — all point at a
decommissioned project; safe to remove from a live task def if still set.

---

## 9. CI/CD WORKFLOWS

### Key Workflows

Canonical deployment is the AWS `AWS-*-DEPLOY-*.yml` family (§1b) plus
`AWS-STAGE-DEPLOY-GATEWAY.yml` for staging. `EXEC-DEPLOY.yml` and ~15 other
GCP-oriented workflow files still in `.github/workflows/` (`AUTO-DEPLOY.yml`,
`STAGE-DEPLOY.yml`, `PROVISION-MEMORYSTORE.yml`, etc.) are dead — GCP is
decommissioned (§1) — do not dispatch them; safe cleanup candidates.

| File | Purpose |
|------|---------|
| `AWS-PROD-DEPLOY-GATEWAY.yml` | Canonical gateway prod deployment (VTID governance, `workflow_dispatch` only, required `reason`) |
| `AWS-STAGE-DEPLOY-GATEWAY.yml` | Gateway staging, auto-deploys on push to `main` |
| `MCP-GATEWAY-CI.yml` | MCP Gateway CI |

### Deployment Requirements
1. VTID must exist in OASIS ledger before deploy (VTID-0542)
2. Governance evaluation must pass (VTID-0416)
3. All deploys go through governed CI pipeline

---

## 11. QUICK REFERENCE (AWS)

### Get a service's live status / task def
```bash
aws ecs describe-services --cluster Vitana-ECS-Cluster \
  --services vitana-gateway-awsdr --region eu-central-1
```

### Get a service's public URL
Resolve via the ALB host-header rule for that service (see §1b's table) —
e.g. gateway is `https://gateway.vitanaland.com`. There is no per-service
dynamic-URL lookup equivalent to `gcloud run services describe`; ECS
services sit behind the shared `vitana-alb-prod` ALB, not their own URL.

### Deploy a service
Deploys go through the canonical `AWS-*-DEPLOY-*.yml` GitHub Actions
workflow for that service (§1b/§9) — `workflow_dispatch` with a required
`reason` for prod, automatic on push for staging. Do not build/push/register
a task definition by hand outside CI.

### Check service logs
```bash
aws logs tail /ecs/vitana-gateway-awsdr --region eu-central-1 --since 1h
```

---

## 12. DOCUMENT REFERENCES

| Document | Purpose |
|----------|---------|
| `DATABASE_SCHEMA.md` | Canonical database schema reference |
| `config/service-path-map.json` | Service to path mapping |
| `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` | Canonical gateway deployment workflow |
| `docs/AWS-PRODUCTION-BUILD-LOG.md` | Full AWS build record and pre-existing-state findings |
| `docs/AWS-CUTOVER-RUNBOOK.md` | Historical record of the GCP→AWS cutover execution |
| `docs/DEPLOYMENT-PIPELINE.md` | Merge → staging → STAGING-VERIFY → ready message → PUBLISH (Part 1 rules 46–50) |
| `docs/MOBILE_DEVICE_TESTING.md` | Device-level frontend testing (sim-use: iOS Simulator / Android) |

---

## 15. DEPLOYMENT VERIFICATION PROTOCOL (VTID-01228)

**This is mandatory for EVERY deployment. No exceptions.**

Deployments have repeatedly failed because the checkout being deployed had stale code, or the wrong branch was deployed. This protocol prevents that.

> **Staging-first note:** by default you are verifying **STAGING**
> (ECS service `vitana-gateway` / `preview-aws-gateway.vitanaland.com`),
> because pushes to `main` auto-deploy staging only. The same curl/revision
> checks below apply — just point them at the staging URL and expect
> `env=staging`. You verify **production** only after a PUBLISH-button
> promotion or an escape-hatch (`scripts/deploy/publish-to-prod.sh`) /
> manual-dispatch deploy — never as a side effect of a push.
>
> **This section is the deploy check (is the right code running?). Whether
> the change actually WORKS on staging is the STAGING-VERIFY test run that
> follows it** — Part 1 rules 46–50, `docs/DEPLOYMENT-PIPELINE.md`. A green
> deploy check alone never justifies asking for production.

### Pre-Deploy Verification (BEFORE the CI build starts)

1. **Verify source code has the expected changes:**
   ```bash
   # Example: Verify sessions route exists before deploying Gateway
   grep -r "sessions" services/gateway/src/routes/live.ts | head -5
   ```
2. **If deploying by hand from a local checkout, verify it's on latest main:**
   ```bash
   git fetch origin
   git log --oneline origin/main -3   # Compare with local repo
   git log --oneline HEAD -3          # Should match
   # If behind:
   git reset --hard origin/main
   ```
3. **Verify the build succeeds locally (TypeScript compiles):**
   ```bash
   cd services/<service> && npm run build
   ```

### Post-Deploy Verification (AFTER the ECS deploy succeeds)

1. **Curl a critical endpoint that only exists in the new code:**
   ```bash
   # Check content-type: must be application/json, NOT text/html
   curl -s -o /dev/null -w "%{http_code} %{content_type}" \
     -X POST "https://gateway.vitanaland.com/api/v1/live/rooms/test/sessions" \
     -H "Content-Type: application/json" -d '{}'
   # Expected: "401 application/json..." (auth required, but JSON = route exists)
   # FAILURE: "404 text/html..." (Express default = route does NOT exist)
   ```
2. **Check the /alive endpoint:**
   ```bash
   curl -s "https://gateway.vitanaland.com/alive"
   ```
3. **Check the latest deployment is serving:**
   ```bash
   aws ecs describe-services --cluster Vitana-ECS-Cluster \
     --services vitana-gateway-awsdr --region eu-central-1 \
     --query 'services[0].deployments'
   ```

### Key Diagnostic: HTML 404 vs JSON 404

| Response | Content-Type | Meaning |
|----------|-------------|---------|
| `Cannot POST /api/v1/...` | `text/html` | **Route does NOT exist** — wrong code deployed |
| `{"error":"ROOM_NOT_FOUND"}` | `application/json` | Route exists, business logic error — correct code |

### Failure Protocol

If post-deploy verification fails:
1. **Do NOT tell the user "deployment succeeded"** — it didn't
2. Check which deployment is serving: `aws ecs describe-services --cluster Vitana-ECS-Cluster --services <svc>`
3. Check the build/deploy logs in the GitHub Actions run
4. Verify the source that was submitted had the correct code

---

## 16. CI/CD DEPLOYMENT PIPELINE — STAGING-FIRST (AWS)

**The staging-first model is unchanged by the AWS cutover — only the
underlying cloud is. The old "merge to main → manually dispatch a GCP prod
deploy" flow is gone because GCP itself is gone.**

### The model: push freely → staging; one button → prod

| Action | Where it lands | How |
|--------|----------------|-----|
| Push / merge to `main` (gateway) | **STAGING** (ECS `vitana-gateway`) | `AWS-STAGE-DEPLOY-GATEWAY.yml`, automatic |
| After every staging deploy | test run on staging | **STAGING-VERIFY**, automatic (Part 1 rules 46–50) |
| Verification passed | developer, in Claude Code + Operator Chat | "Staging verified — ready for deployment to production?" |
| Developer says yes | `gateway` (+ frontend) | **PUBLISH** (button / Operator Chat action / pinned dispatch from Claude Code) |
| Exceptional manual prod deploy | single service | `scripts/deploy/publish-to-prod.sh` |

- **`AWS-STAGE-DEPLOY-GATEWAY.yml`** auto-deploys staging on every push to
  `main` under `services/gateway/**`. Smoke-gates on `/api/v1/admin/health`
  → `env=staging`.
- **`AWS-PROD-DEPLOY-*.yml`** (one per service, §1b) is `workflow_dispatch`-only
  with a required `reason` — never on push. That's the deliberate prod
  lever, driven by the PUBLISH button and the escape-hatch script.

### End-to-End Deployment Checklist (STAGING-FIRST)

When changing code:

1. **Code fix** — on the feature/`claude/` branch.
2. **Commit** — include a VTID (`(VTID-XXXXX)`) or `BOOTSTRAP-<description>`.
3. **Push** — to the `claude/` branch; open a PR.
4. **Merge to `main`** — this auto-deploys to **STAGING only**. The PR must
   already carry `docs/validation/<VTID>/staging-tests.json` (Part 1 rule 47).
5. **STAGING-VERIFY** — runs automatically after the staging deploy: smoke
   suite + the change suite, read-only, on the exact deployed commit
   (`preview-aws-gateway.vitanaland.com` / `preview-aws.vitanaland.com`).
   Keep watching until it has a result: the run `STAGING-VERIFY <service> @
   <sha>` / the `staging.verify.*` OASIS event. Do **NOT** expect or look for
   a prod deploy here.
6. **Ready message** — on a pass, ask the developer in the Claude Code
   session (the Operator Chat gets the same message): *"Staging verified —
   ready for deployment to production?"* with the verified commit, the
   results and every commit between production and it. On a failure: fix
   forward, no prompt.
7. **Ship to production** — on a "yes", PUBLISH: the Command Hub promotion,
   or from Claude Code the same prod workflow(s) pinned to the verified commit:
   ```
   gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml --repo exafyltd/vitana-platform \
     -f reason="VTID-XXXXX — STAGING-VERIFY <run url> passed, approved in session" \
     -f expected_commit=<verified commit SHA>
   ```
   (`scripts/deploy/publish-to-prod.sh` wraps the dead GCP-era
   `EXEC-DEPLOY.yml` — do not use it.)
8. **Verify prod** — deploy check only, per §15, plus the workflow's own
   read-only post-deploy check with automatic rollback (VTID-04647). No test
   suite ever runs against production.

### Do NOT manually dispatch a prod deploy workflow as a routine step

Merging deploys staging. Prod is a deliberate, separate, governed action
(PUBLISH button or escape-hatch script with a recorded reason). If you find
yourself hand-dispatching `AWS-PROD-DEPLOY-GATEWAY.yml` to prod as a
routine step rather than a deliberate, reasoned action, stop — that
reintroduces the auto-to-prod behavior the staging-first cutover removed.

### A session-approved manual prod deploy ships that session's change only (Part 1 IF-THEN 26)

> **With the Staging Verification Gate (Part 1 rules 46–50)** the ready
> message lists every commit between production and the verified commit, so
> a "yes" to it is an explicit approval of exactly that range — IF-THEN 26 is
> satisfied by the list, not waived. A range the message did not show was
> not approved. Everything below still applies to any prod deploy that did
> not come from a ready message.

When the user approves a production deploy in conversation and it goes out
via a manual `workflow_dispatch` — **not** the Command Hub PUBLISH button —
the approval covers this session's own change, not the current state of
staging/`main` as a whole. Pin the commit on the workflow's own input:

```
gh workflow run AWS-PROD-DEPLOY-GATEWAY.yml --repo exafyltd/vitana-platform \
  -f reason="why this exceptional prod deploy is justified" \
  -f expected_commit=<this session's merge commit SHA>
```

**Do not use `scripts/deploy/publish-to-prod.sh` for this.** Its `--ref`
forwards straight to `gh workflow run --ref`, which GitHub's
`workflow_dispatch` API only accepts as a branch or tag — never a raw
commit SHA — so passing a commit there fails before anything deploys. The
script also wraps `EXEC-DEPLOY.yml`, the GCP/Cloud Run-era workflow §9
already flags as dead code now that GCP is decommissioned (§1); do not
dispatch it. Dispatch the live `AWS-PROD-DEPLOY-*.yml` workflow for the
service directly instead, as above.

Leaving `expected_commit` empty, or `deploy_mode` at its default
(`promote-staging`) with no `expected_commit`, ships whatever staging is
currently running **as a whole** — including any other work that happens
to have landed on `main` or staging ahead of this session's commit, whether
or not the user in this conversation ever saw or approved it. That is
exactly what PUBLISH is *for* (a deliberate, human-operated promotion of
the entire tested staging build) and exactly what an in-session approval
is not.

**Pinning `--ref`/`expected_commit` is necessary, not sufficient.** The
workflow checks out (or, for `promote-staging`, ships an image built from)
the full repository snapshot AT that commit, not a diff — so a pinned
commit still includes every ANCESTOR commit, including anything merged to
`main`/staging before this session's own work that nobody in this
conversation reviewed. Diff the pinned commit against what
`/api/v1/admin/build-info` reports as currently live in production (§15)
and confirm every commit in that range is this session's own or separately
approved. If it isn't, and it can't be excluded — no path here ships a
pinned diff, only a full snapshot — stop and tell the user what else would
ship alongside theirs rather than shipping it silently.

### CSS/JS Cache-Busting

The Gateway serves static files with `Cache-Control: no-cache, no-store, must-revalidate`, so browser caching is NOT an issue. However, `index.html` has `?v=` parameters on CSS/JS links. **Always bump these version strings** when making frontend changes to be safe:
```html
<link rel="stylesheet" href="/command-hub/styles.css?v=YYYYMMDD-HHMM" />
<script src="/command-hub/app.js?v=YYYYMMDD-HHMM"></script>
```

### GitHub access for API operations (VTID-04019 — no token material in this file)

This section used to print the first characters of two live personal access
tokens. It no longer does, and must never again: a rules file that every
session force-loads is the worst place for credential material, partial or
not (`services/gateway/test/vtid-04019-no-token-prefixes-in-docs.test.ts`
fails the build if a `github_pat_…`/`ghp_…`-shaped prefix reappears here or
under `docs/`).

Where the tokens actually live, and how each consumer gets them:

- **Gateway / executor (`GITHUB_SAFE_MERGE_TOKEN`)** — AWS Secrets Manager
  secret **`vitana/github/pat`**, for both gateways and the executor, wired
  into the ECS task definitions by `AWS-STAGE-DEPLOY-GATEWAY.yml` /
  `AWS-PROD-DEPLOY-*.yml`; the platform repo's PR/merge/dispatch calls in
  `services/gateway/src/services/github-service.ts` read it from the
  environment. `vitana/github/token` expired on 2026-09-25 (401) and is
  **retired by owner decision (VTID-04573/04583)** — never point a task
  definition back at it.
- **`exafyltd/vitana-v1` (`FRONTEND_DEPLOY_TOKEN`)** — same mechanism; the
  operator's cross-repo reads (`dev_read_file` / `dev_search_codebase` with
  `repo:"exafyltd/vitana-v1"`) and the PUBLISH button's frontend promotion
  use it.
- **A Claude Code session** — uses the GitHub MCP tools (`mcp__github__*`)
  and `add_repo`; it never needs, and must never be given, a raw PAT in
  conversation or in a file.
- **GitHub Actions** — repository secrets, referenced as
  `${{ secrets.… }}` in the workflow that needs them.

If a token is ever pasted into a file, a chat, or a log, treat it as leaked:
rotate it in GitHub, update the Secrets Manager value, redeploy the task
defs that carry it, and record the rotation in this file's CHANGE LOG.

---

