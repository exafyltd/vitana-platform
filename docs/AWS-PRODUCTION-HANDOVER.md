# Handover: Build AWS Production (Parallel/DR) for the Gateway

**Written:** 2026-07-21, end of the AWS-staging-validation session
**Repo:** `exafyltd/vitana-platform` (GitHub MCP access already scoped in this environment)
**Scope agreed with the user:** a **parallel/DR production** on AWS, gateway
service only, running *alongside* GCP prod — not a migration. GCP stays the
canonical production. Do not touch GCP production or any currently-live DNS.

---

## Mission for this session

Stand up a second, independent, fully-governed production environment for the
`gateway` service on AWS (ECS/Fargate), matching the rigor of the existing GCP
prod path (deliberate promotion only, verified deploys, monitoring). AWS
*staging* already exists and works — this session extends that pattern one
tier up, it does not build from scratch.

## Explicit non-goals / guardrails

- Do **not** change any GCP production resource, config, or DNS.
- Do **not** point any currently-live hostname (GCP or AWS, staging or prod)
  at new infrastructure without explicit user sign-off.
- Do **not** wire AWS prod deploys to trigger on push to `main`. This must be
  `workflow_dispatch`-only with a required `reason`, exactly like how GCP
  prod is gated post-cutover (CLAUDE.md §16). Auto-deploy-to-prod is the
  single biggest way to get this wrong.
- Do **not** extend this to the other 4 deployable services
  (oasis-operator, oasis-projector, verification-engine, worker-runner) or
  the frontend yet. Gateway-only is the agreed first slice — mention the
  natural next steps, don't build them preemptively.
- **Governance:** CLAUDE.md requires a VTID before any execution/deployment
  and `spec_status=approved` before executing. Get one allocated for "AWS
  Production (DR) — Gateway" before touching infrastructure.

## How we got here (context, not required reading, but explains the "why")

1. An earlier workstream (`BOOTSTRAP-AWS-STAGING-VALIDATION`) stood up AWS
   *staging* for the gateway: ECS/Fargate service, ECR, deploy pipeline,
   validation scripts + docs (`scripts/aws-staging-validation/`,
   `docs/AWS-STAGING-VALIDATION.md`).
2. This session (branch `claude/happy-mayer-k58y5h`, PRs #2903/#2904/#2905,
   all merged) diagnosed and fixed ORB voice-to-voice failing on AWS staging:
   wrong Gemini Live model id (fixed via ListModels ground truth), then a
   `system_instruction` payload silently exceeding its own 30KB budget guard
   (fixed by skipping a redundant tools-prose block on the AI-Studio/non-Vertex
   path). AWS staging gateway now streams live ORB voice sessions end-to-end,
   verified via a raw SSE session (POST `/api/v1/orb/live/session/start`,
   stream `/api/v1/orb/live/stream`, confirm `audio`/`output_transcript`
   events and a clean close instead of `code=1007`).
3. The user then asked how much work a **production** AWS build is. That
   scoping conversation (recorded in this session's transcript) is what led
   here — read it if available; if not, this document supersedes it.

## Current AWS staging state (verified live via aws-cli during this session)

| Item | Value |
|---|---|
| AWS account | `472838866351` |
| Region | `eu-central-1` |
| ECS cluster | `Vitana-ECS-Cluster` |
| ECS service (staging) | `vitana-gateway` (Fargate, 1024 CPU / 2048 MB, desiredCount=1, **no autoscaling policy found**) |
| Task definition | `vitana-gateway` family, revision 29 at time of writing |
| Task exec / task roles | `vitana-ecs-task-execution-role` / `vitana-ecs-task-role` |
| ECR repo | `vitana/gateway` (tags include commit-short-sha and `staging-latest`) |
| Log group | `/vitana/gateway` (CloudWatch) |
| Subnets | `subnet-0ff45a2051c5e5482`, `subnet-0c786864a28a5a821` (private — `assignPublicIp=DISABLED`, behind an ALB) |
| Security group | `sg-0fbcf7b59b1f0d685` |
| Public URL | `https://preview-aws-gateway.vitanaland.com` |

**⚠️ Flag this first:** the staging service's target group is already named
`vitana-tg-gateway-prod`
(`arn:aws:elasticloadbalancing:eu-central-1:472838866351:targetgroup/vitana-tg-gateway-prod/3eaf5198344fe413`)
even though it's currently serving *staging* traffic. Before building
anything, run `aws elbv2 describe-target-groups` /
`describe-load-balancers` / `describe-listeners` in `eu-central-1` to
understand whether this is just a leftover naming choice from the original
setup, or whether a partial prod ALB/listener already exists from earlier
work. Don't assume — verify, per CLAUDE.md's "never assume context that is
not verified."

**Deploy pipeline (staging):** `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`
— builds the gateway image, pushes to ECR, patches the *existing* task
definition's image + 3 commit-stamp env vars (`GIT_COMMIT_SHA`, `COMMIT_SHA`,
`BUILD_INFO_MARKER`) in place (everything else on the task def carries
forward untouched), calls `ecs update-service` + `wait services-stable`,
smoke-gates on `/api/v1/admin/health` (`env=staging`) and
`/api/v1/admin/build-info` (commit match), then best-effort emits an OASIS
event + `software_versions` row via Supabase REST. Runs automatically on push
to `main` touching `services/gateway/**`, or via manual dispatch with
configurable region/cluster/service/repo inputs.

**IAM for staging deploys:** static keys — repo secrets
`AWS_STAGING_ACCESS_KEY_ID` / `AWS_STAGING_SECRET_ACCESS_KEY`, reportedly an
IAM user named `claude-staging-validation` (per the workflow's header
comment). **This is a shortcut worth not repeating for prod** — a separate,
older workflow (`scripts/aws/README.md`, the GCS→S3 artifact mirror) already
uses proper GitHub OIDC federation (no static keys, trust policy scoped to
`repo:exafyltd/vitana-platform:*`). Use that pattern for prod IAM.

**Task def env vars (live, revision 29):** `VITANA_ENV`, `ENVIRONMENT`, `ENV`,
`FEATURE_INTENT_ENGINE_A`, `FEATURE_ORB_SAFE_FAST_GREETING_ENV`,
`FEATURE_ORB_FAST_START_ENV`, `FEATURE_LATENCY_TELEMETRY_ENV`,
`NAV_GUIDED_JOURNEY`, `NAV_CONTINUATION_BIND`,
`ORB_CONTEXT_READY_GATE_TIMEOUT_MS`, `VTID_ALLOCATOR_ENABLED`,
`GATEWAY_SERVICE_TOKEN`, `GEMINI_LIVE_TRANSPORT`, `GOOGLE_GEMINI_API_KEY`,
`GEMINI_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `DB_HOST`,
`DB_READER_HOST`, `REDIS_HOST`, `AWS_REGION`, `GATEWAY_URL`, plus the
deploy-stamped commit vars.

**Task def secrets (Secrets Manager):** `DB_PASSWORD`, `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE`. Per `docs/AWS-STAGING-VALIDATION.md` §4, AWS staging
*deliberately* points at the same Supabase project GCP prod uses
(`inmkhvwdcuyhnxkgfvsb`) — confirm with the user whether AWS prod should do
the same (almost certainly yes, since Supabase is the shared data plane
regardless of compute host) before assuming.

**No IaC exists anywhere in this repo** (no Terraform/CDK/CloudFormation) —
the entire staging stack above was provisioned by hand via aws-cli/console.
For prod you can either repeat that by hand (fast, proven pattern, but not
reviewable or reproducible) or write IaC first (more upfront work, pays off
if this DR pattern later expands to more services). Recommend deciding this
with the user before starting — it changes the shape of the work.

## What's actually not built yet

1. **Prod compute** — a *new* ECS service (e.g. `vitana-gateway-prod`) with
   its own task definition. Do not repoint the existing `vitana-gateway`
   staging service at prod — that would destroy the staging environment just
   validated.
2. **Prod secrets** — new Secrets Manager entries scoped to prod (confirm
   per-secret whether staging/prod share values or not).
3. **Prod IAM** — GitHub OIDC federation (mirror `scripts/aws/README.md`),
   not another static-key IAM user.
4. **ALB / target group / listener** for prod traffic — resolve the
   `vitana-tg-gateway-prod` naming question first (see flag above).
5. **DNS + TLS** — a prod hostname (not any hostname currently live in GCP
   prod), ACM cert, Route53 record. Needs a decision from the user on the
   hostname.
6. **`AWS-PROD-DEPLOY-GATEWAY.yml`** — a twin of the staging workflow, but
   `workflow_dispatch`-only, required `reason` input, **never on push**.
   This is the single most important property to get right.
7. **Autoscaling + CloudWatch alarms/dashboard** — staging today is a fixed
   `desiredCount=1` with no scaling policy; prod needs at least a target-
   tracking policy and basic alarms (5xx rate, task health, CPU/mem).
8. **CLAUDE.md governance update** — §1 currently states "Always use GCP
   project `lovable-vitana-vers1`" and "Never invent new projects,
   environments, or services" as absolute rules. Add an explicit section
   (with the allocated VTID) sanctioning the AWS DR pattern — otherwise the
   canonical reference actively contradicts what's being built.

## Suggested execution order

1. Allocate/confirm a VTID for "AWS Production (DR) — Gateway"; do not
   proceed past `spec_status=approved`.
2. Investigate the `vitana-tg-gateway-prod` naming (`describe-target-groups`
   / `describe-load-balancers` / `describe-listeners` in `eu-central-1`) so
   you know whether you're building fresh or continuing partial prior work.
3. With the user, decide: prod hostname, and whether AWS prod shares GCP
   prod's Supabase project (expected: yes).
4. Build the stack top-down: Secrets Manager → task definition → ECS service
   → target group/listener → DNS/TLS, using task def revision 29 (staging)
   as the template and swapping in prod-scoped values.
5. Set up GitHub OIDC federation for prod deploy credentials.
6. Write `AWS-PROD-DEPLOY-GATEWAY.yml` (dispatch-only, required `reason`,
   same smoke-gate shape as staging but asserting whatever `VITANA_ENV`
   value you choose for prod).
7. Deploy once manually; verify with the same protocol as staging (CLAUDE.md
   §15 — JSON not HTML 404, `/alive`, build-info commit match) **plus** a
   live ORB voice session test: POST `/api/v1/orb/live/session/start`, then
   stream the SSE endpoint (`/api/v1/orb/live/stream?session_id=...`) for
   ~15s and confirm `audio`/`output_transcript` events with no `code=1007`
   close.
8. Update CLAUDE.md with the new AWS-prod section referencing the VTID.

## Key files to read first

- `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` — the deploy pattern to
  mirror for prod (read the design-choices comment block at the top).
- `scripts/aws/README.md` — the OIDC federation pattern to reuse for prod
  IAM instead of static keys.
- `docs/AWS-STAGING-VALIDATION.md` — the full staging parity checklist; most
  of §1 (automated parity), §4 (config/secrets parity), and §6 (DNS/TLS)
  apply again, one tier up, for prod.
- `CLAUDE.md` §15/§16 — deployment verification protocol and the
  staging-first governance model; both need an AWS-prod-aware addendum.
- Branch `claude/happy-mayer-k58y5h` history (PRs #2903, #2904, #2905) — for
  how the live ORB session test was actually run against AWS, if you need a
  concrete example beyond the description above.

## Repos in scope

- `exafyltd/vitana-platform` — primary, all the work above lives here.
- `exafyltd/vitana-v1` (frontend) — out of scope for this slice; note as a
  later step if DR ever needs to include frontend failover.
