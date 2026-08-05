# CLAUDE.md - Vitana Platform Development Guide
**CANONICAL REFERENCE - Last Updated: 2026-01-21**

This file contains critical information for AI assistants working on the Vitana platform.
**READ THIS BEFORE MAKING ANY CHANGES.**

---

# PART 1: CORE RULES (Always / Never / If–Then)

These are **non-negotiable behavioral rules** for developing the Vitana platform.

---

## ✅ ALWAYS RULES

Claude must **always** do the following:

### Source of Truth & Governance

1. **Always treat OASIS as the single source of truth** for task state, lifecycle, and governance.
2. **Always verify VTID existence** before execution, deployment, or automation.
2b. **Always self-allocate the VTID.** Every new task — a bug report, a
    feature ask, a "fix this," a doc change, anything that results in a
    commit — gets its own VTID, allocated by Claude itself from the ledger
    (`POST /api/v1/vtid/allocate`, or directly via the `allocate_global_vtid`
    Supabase RPC when the gateway endpoint isn't reachable from the session)
    at the START of the work, BEFORE touching any code. This is standing,
    permanent governance — yesterday, today, and always. **Never ask the
    user whether a VTID is needed, never ask them to supply one, and never
    wait for confirmation before allocating.** Set `spec_status='approved'`
    and `status='in_progress'` on the freshly allocated row when the user
    has directly instructed the work in conversation — that instruction
    IS the approval (see IF-THEN rule "task moved to in_progress manually
    → explicit consent"). Multiple distinct fixes in one conversation get
    multiple distinct VTIDs, not one VTID shared across unrelated changes.
    (VTID-03448)
3. **Always check memory first** before proposing changes, fixes, or new systems.
4. **Always respect existing governance rules** over new ideas or optimizations.
5. **Always require `spec_status=approved`** before execution.
6. **Always terminalize tasks** (`is_terminal=true`) when finished.
7. **Always emit OASIS events** for real state transitions.
8. **Always assume defense-in-depth** (multiple gates are intentional).
9. **Always prefer existing systems** over rebuilding.
10. **Always fail loudly** if a required invariant is missing.

### Infrastructure & Deployment

11. **Always use GCP project `lovable-vitana-vers1`.**
12. **Always deploy in `us-central1`.**
13. **Always resolve Cloud Run URLs dynamically** via `gcloud`.
14. **Always use Artifact Registry (`pkg.dev`)**, never `gcr.io`.
15. **Always expose `/alive`** as the health endpoint.
16. **Always use port `8080`.**
17. **Always read `.gcp-config` before GCP commands.**
18. **Always deploy via the canonical deploy scripts.**
19. **Always log provider, model, and latency for AI calls.**
20. **Always treat CI/CD as governed, not ad-hoc.**
21. **Always verify source code BEFORE deployment** — grep for critical routes/features in the deploy source to confirm they exist.
22. **Always verify deployment AFTER deploy** — curl critical endpoints to confirm the new code is live (check for JSON responses, not HTML 404s).
23. **Always verify Cloud Shell is on latest `origin/main`** before deploying — run `git log --oneline -3` and compare with local repo.

### Database & Memory

21. **Always use Supabase as the persistent data store.**
22. **Always enforce tenant isolation (RLS).**
23. **Always use snake_case table names.**
24. **Always update `DATABASE_SCHEMA.md` when schema changes.**
25. **Always route DB mutations through Gateway APIs.**
26. **Always treat `memory_items` as canonical infinite memory.**
27. **Always use pgvector for semantic memory.**
28. **Always scope memory by tenant + role.**
29. **Always retrieve memory selectively (relevance-based).**
30. **Always log memory debug snapshots in dev.**

### Frontend & UX

31. **Always preserve sidebar structure and order.**
32. **Always keep exactly 10 sidebar items.**
33. **Always keep Start Stream in the sidebar utility zone.**
34. **Always treat Start Stream as private AI + screen share.**
35. **Always treat ORB as voice-first, multimodal.**
36. **Always comply with CSP (no inline scripts/styles).**
37. **Always bundle JS locally.**
38. **Always respect fixed layout regions.**
39. **Always use Markdown specs (no Figma).**
40. **Always maintain WCAG 2.2 AA compliance.**

---

## ❌ NEVER RULES

Claude must **never** do the following:

### Architecture & Logic

1. **Never invent new projects, environments, or services.** (Exception:
   the AWS parallel/DR environment, sanctioned under **VTID-03398,
   VTID-03409, VTID-03410, VTID-03411, VTID-03414, VTID-03415** — see
   §1b. GCP remains canonical production for every service **except
   gateway and community-app** — those two were cut over to AWS as
   sole production under **VTID-03419** (2026-07-27; DNS execution
   record in `docs/AWS-CUTOVER-RUNBOOK.md` §3). Everything else (Aurora
   as a failover target, oasis-projector, orb-agent, autopilot-cdc, and
   full GCP decommission) remains additive DR only — not yet a
   sole-production cutover, and still gated on that runbook's §2
   checklist plus its own separate execution VTID. Extending AWS-DR to
   a service not already listed in §1b still needs its own new VTID.)
2. **Never bypass governance gates.**
3. **Never execute without a VTID.**
4. **Never deploy without OASIS approval.**
5. **Never rebuild systems that already exist.**
6. **Never assume context that is not verified.**
7. **Never mix tenant data.**
8. **Never bypass RLS.**
9. **Never write directly to the database from workers.**
10. **Never mark polling or heartbeats as OASIS events.**

### Infrastructure & CI/CD

11. **Never hardcode URLs, paths, or service names.**
12. **Never deploy to the wrong GCP project.**
13. **Never use `/healthz` for Cloud Run health checks.**
14. **Never use deprecated `gcr.io`.**
15. **Never run parallel VTID executions.**
16. **Never skip schema documentation updates.**
17. **Never push ungoverned production changes.**
18. **Never assume deployment success without verification.**
19. **Never silence errors.**
20. **Never auto-fix without explaining root cause.**

### Frontend & UX

21. **Never move Start Stream outside the sidebar.**
22. **Never confuse Start Stream with Go Live / Live Rooms.**
23. **Never change sidebar navigation.**
24. **Never introduce inline JS or CSS.**
25. **Never load JS from CDNs.**
26. **Never add new Wallet routes.**
27. **Never invent UI screens.**
28. **Never break layout invariants.**
29. **Never ship experimental UI to prod.**
30. **Never violate CSP, even temporarily.**

### AI & Autonomy

31. **Never hallucinate data.**
32. **Never invent memory.**
33. **Never override AI routing rules.**
34. **Never enable autonomy without explicit approval.**
35. **Never allow silent model fallback.**
36. **Never skip memory retrieval.**
37. **Never respond confidently when uncertain.**
38. **Never hide governance failures.**
39. **Never change provider priority ad-hoc.**
40. **Never bypass validation.**

---

## 🔁 IF–THEN RULES

Claude must apply the following **conditional logic**:

### VTID & Execution

1. **IF** VTID does not exist → **THEN self-allocate one immediately (see
   Part 1 rule 2b / §4.1) and continue. THEN STOP only applies to VTIDs
   that fail to allocate (allocator disabled, DB error) — never to the
   mere absence of one, and never as a prompt to ask the user for one.**
2. **IF** `spec_status ≠ approved` → **THEN DO NOT EXECUTE**, unless the
   user has directly instructed the work in this conversation, in which
   case set `spec_status='approved'` yourself when self-allocating (rule
   2b) and proceed.
3. **IF** `is_terminal=true` → **THEN DO NOT MODIFY TASK.**
4. **IF** task is `scheduled` → **THEN treat as standby only.**
5. **IF** task is moved to `in_progress` manually → **THEN treat as explicit consent.**

### Governance

6. **IF** governance fails → **THEN execution is forbidden.**
7. **IF** emergency bypass is used → **THEN log + escalate.**
8. **IF** execution is disarmed → **THEN monitor only.**
9. **IF** rules conflict → **THEN prefer stricter rule.**
10. **IF** uncertain → **THEN stop and ask.**

### Infrastructure

11. **IF** GCP project ≠ `lovable-vitana-vers1` → **THEN STOP.**
12. **IF** service URL is unknown → **THEN resolve dynamically.**
13. **IF** `/healthz` is used → **THEN replace with `/alive`.**
14. **IF** Artifact Registry is not used → **THEN fix before deploy.**
15. **IF** CI/CD token is missing → **THEN abort merge.**

### Deployment Verification

16. **IF** deploying to Cloud Run → **THEN grep source for critical routes/features BEFORE `gcloud builds submit`.**
17. **IF** deploy completes → **THEN curl critical endpoints and confirm JSON response (not HTML 404).**
18. **IF** curl returns `text/html` content-type → **THEN the route does NOT exist on deployed code — deploy failed or wrong code.**
19. **IF** deploying from Cloud Shell → **THEN run `git fetch origin && git log --oneline origin/main -3` and compare with local repo to confirm Cloud Shell has latest code.**
20. **IF** Cloud Shell is behind `origin/main` → **THEN run `git reset --hard origin/main` before deploying.**

### Targeted Visual Verification (MANDATORY - Updated 2026-04-14)

**Core principle: screenshot what you changed, interact with it, verify it works — before reporting done.**

26. **AFTER finishing any UI change** (button, layout, page, modal, form, nav) → run this protocol BEFORE telling the user it's done:

    **Step 1 — Identify what to verify:**
    Look at your own diff. What pages/components did you change? Those are the ONLY pages you need to screenshot. Not 20 pages — just the ones you touched.

    **Step 2 — Screenshot the changed page(s):**
    Use Playwright to navigate to the specific page you changed. Screenshot it in BOTH viewports:
    - Desktop: 1400×900
    - Mobile (iPhone 14): 390×844
    ```typescript
    // Example: you changed the Settings page
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('https://community-app-q74ibpv6ia-uc.a.run.app/settings');
    await page.screenshot({ path: '/tmp/settings-mobile.png' });
    ```

    **Step 3 — Interact with the changed element:**
    If you added/changed a button → click it, screenshot the result.
    If you added/changed a modal → open it, screenshot it open.
    If you added/changed a form → fill it, screenshot the filled state.
    If you added/changed a redirect → navigate, verify the URL changed.
    If you added/changed a drawer → open it, screenshot the overlay.

    **Step 4 — Read and inspect the screenshots:**
    Use the Read tool to view each screenshot image. Check:
    - Does the element look correct? (spacing, alignment, colors)
    - Is text readable and not clipped?
    - On mobile: is there horizontal overflow? Are tap targets large enough?
    - Does the interaction produce the expected result?
    - Are there any visual glitches, overlapping elements, or missing content?

    **Step 5 — Fix or report:**
    - If the screenshot shows problems → fix them, redeploy, re-screenshot.
    - If the screenshot looks correct → report completion WITH the screenshot evidence.

27. **NEVER** report a UI change as "done" without having taken and visually inspected a screenshot of the specific thing you changed.
28. **NEVER** screenshot 20 pages when you changed 1 button. Verify what you changed, not the entire app.
29. **IF** Playwright deps are missing on WSL2 → set `LD_LIBRARY_PATH="/tmp/chromium-libs/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH"` or install via `apt download` + `dpkg-deb -x`.
30. **IF** you cannot run Playwright at all → use `curl` to fetch the page HTML and verify the changed element exists in the DOM. This is a fallback, not the standard.

**Test user UUID:** `a27552a3-0257-4305-8ed0-351a80fd3701`
Use this user when an authenticated user is needed for testing (e.g., Playwright screenshots, API calls, profile checks).

**Auth for frontend screenshots (Supabase REST):**
```typescript
// Sign in via API, inject into localStorage — no brittle form selectors
const session = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
  body: JSON.stringify({ email: 'e2e-test@vitana.dev', password: 'VitanaE2eTest2026!' }),
}).then(r => r.json());
await page.evaluate(s => {
  localStorage.setItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token', JSON.stringify(s));
  localStorage.setItem('vitana.authToken', s.access_token);
  localStorage.setItem('vitana.viewRole', 'community');
}, session);
await page.reload();
```

### CI/CD Pipeline — STAGING-FIRST (CRITICAL - Updated 2026-06-04)

> **Cutover rule (time-gated):** the switch flips at **Mon 8 Jun 2026, 10:00
> Europe/Berlin** (08:00 UTC). **Before** that instant, every deploy path
> reaches production on push as it always did. **At/after** it, every automatic
> (push) deploy path is FROZEN from prod and auto deploys land on **staging
> only**. Production is then reached **only** via (a) the single PUBLISH button
> in the Command Hub, or (b) a deliberate manual run — `workflow_dispatch` of
> the relevant deploy workflow, or `scripts/deploy/publish-to-prod.sh`. The gate
> lives in each deploy workflow's `cutover_gate` job; manual dispatch is never
> frozen. No redeploy is needed to flip it — it is purely time-based.

21. **IF** you push/merge to `main` **on/after the cutover** → **THEN it deploys to STAGING (gateway via `STAGE-DEPLOY.yml` → `gateway-staging`). It does NOT touch production. Verify on `preview-gateway.vitanaland.com`, not prod.**
22. **IF** you need code on PRODUCTION (post-cutover) → **THEN do NOT push and expect prod to update. Either click PUBLISH in the Command Hub (promotes the tested staging build) or run `scripts/deploy/publish-to-prod.sh --service <svc> --vtid <id> --reason "<why>"` (the explicit exception).**
23. **IF** you are tempted to manually dispatch `EXEC-DEPLOY.yml` to prod "to be safe" post-cutover → **THEN STOP. That is the old auto-to-prod habit. Auto = staging. Prod = PUBLISH button or escape-hatch/manual dispatch only, with a recorded reason.**
24. **IF** `worker-runner` / `vitana-orb-agent` / the autopilot job needs a prod update post-cutover → **THEN use the escape-hatch script or the workflow's manual `workflow_dispatch`. These have no staging twin yet, so they are freeze-only on the auto path until one exists.**
25. **IF** making frontend CSS/JS changes (Command Hub) → **THEN bump the `?v=` cache-busting parameter in index.html. Post-cutover the change auto-deploys to STAGING; it reaches prod only when PUBLISH is clicked.**

### Memory

16. **IF** memory exists → **THEN retrieve, don't recreate.**
17. **IF** memory is irrelevant → **THEN do not inject.**
18. **IF** tenant context is missing → **THEN do not proceed.**
19. **IF** memory write fails → **THEN emit error event.**
20. **IF** memory schema changes → **THEN migrate + document.**

### Frontend & UX

21. **IF** change touches sidebar → **THEN it is forbidden.**
22. **IF** JS must run → **THEN it must be external.**
23. **IF** UI spec conflicts with canon → **THEN canon wins.**
24. **IF** accessibility fails → **THEN block release.**
25. **IF** screen is not in inventory → **THEN do not add it.**

### AI & Autonomy

26. **IF** planner is needed → **THEN use Gemini Pro.**
27. **IF** worker is needed → **THEN use Gemini Flash.**
28. **IF** validation is needed → **THEN use Claude.**
29. **IF** model fallback occurs → **THEN log explicitly.**
30. **IF** TTS is used → **THEN specify model_name explicitly.**

---

# PART 2: TECHNICAL REFERENCE

---

## 1. GCP INFRASTRUCTURE (CRITICAL - DO NOT GUESS)

| Setting | Value |
|---------|-------|
| **GCP Project ID** | `lovable-vitana-vers1` |
| **Region** | `us-central1` |
| **Artifact Registry** | `us-central1-docker.pkg.dev/lovable-vitana-vers1/<repo>/<service>` |
| **Artifact Registry Repos** | `cloud-run-source-deploy`, `crewai-gcp` |

### Cloud Build Pattern
```bash
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/lovable-vitana-vers1/cloud-run-source-deploy/<service>:latest \
  --project lovable-vitana-vers1

gcloud run deploy <service> \
  --image us-central1-docker.pkg.dev/lovable-vitana-vers1/cloud-run-source-deploy/<service>:latest \
  --region us-central1 \
  --project lovable-vitana-vers1
```

---

## 1b. AWS PRODUCTION (DR) (VTID-03398, VTID-03409, VTID-03410, VTID-03411, VTID-03414, VTID-03415)

GCP (`lovable-vitana-vers1`) remains the **canonical** production for every
service **except gateway and community-app**. Those two were cut over to
AWS as **sole production** under **VTID-03419** (2026-07-27) — see
`docs/AWS-CUTOVER-RUNBOOK.md` §3 for the DNS execution record. For every
other service in the table below, AWS remains **parallel/DR production
infrastructure** — additive capacity, not a migration, not yet a
sole-production cutover, gated on `docs/AWS-CUTOVER-RUNBOOK.md`
(VTID-03412) §2's checklist and its own separate execution VTID.
Extending this pattern to a service not listed in the table below still
needs its own new VTID.

| Service | VTID | ECS resource / dispatch | Public URL / access | Deploy workflow |
|---|---|---|---|---|
| gateway | VTID-03398 | ECS service `vitana-gateway-awsdr`, task def family `vitana-gateway-awsdr`, target group `vitana-tg-gateway-awsdr` | `https://dr-gateway.vitanaland.com` (ALB host rule, priority 5) | `AWS-PROD-DEPLOY-GATEWAY.yml` |
| community-app (frontend) | VTID-03409, cut over to sole production VTID-03419 | ECS service `vitana-community-app-awsdr` (now serving `vitanaland.com` apex + `www`, not just the `dr-app` DR hostname), target group `vitana-tg-community-awsdr` | `https://dr-app.vitanaland.com` (ALB host rule, priority 6) **and** `https://vitanaland.com` (apex/`www`, since VTID-03419 — routed via a Cloudflare Worker whose origin was repointed at cutover time, not by DNS alone, see runbook §3.2); static SPA build bakes the canonical gateway URL (`gateway.vitanaland.com`, itself AWS since VTID-03419) into `.env.production` — no runtime env var to flip | `AWS-PROD-DEPLOY-FRONTEND.yml` (in `exafyltd/vitana-v1`) — still on static `AWS_STAGING_ACCESS_KEY_ID`/`SECRET` repo secrets, not yet OIDC (follow-up) |
| oasis-operator | VTID-03410 | ECS service `vitana-oasis-operator-awsdr` (256 CPU/512MB, stateless, no DB dependency), target group `vitana-tg-oasis-op-awsdr` | `https://dr-oasis-operator.vitanaland.com` (ALB host rule, priority 7) | `AWS-PROD-DEPLOY-OASIS-OPERATOR.yml` — first CI/CD path this service has ever had; its source didn't exist in git and was restored from a stale `.backup` snapshot |
| oasis-projector | VTID-03411 | ECS service `vitana-oasis-projector`, fixed `desiredCount` — **no autoscaling**, the Ledger Writer has no cross-instance locking | No public ALB/DNS — internal DB reconciliation loop; verify via ECS `healthStatus` (`/ready`) | `AWS-PROD-DEPLOY-OASIS-PROJECTOR.yml` |
| worker-runner | VTID-03411 | ECS service `vitana-worker-runner`, fixed `desiredCount` | No public ALB/DNS — polls outward to gateway; verify via ECS `healthStatus` (`/alive`) | `AWS-PROD-DEPLOY-WORKER-RUNNER.yml` |
| verification-engine | VTID-03411 | ECS service `vitana-vitana-verification-engine`, fixed `desiredCount` | No public ALB/DNS — self-registers heartbeat outward; verify via ECS `healthStatus` (`/health`) | `AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml` |
| orb-agent | VTID-03414 | ECS service + task def family `vitana-orb-agent` — **pre-existing** from the unexplained 2026-07-09 bulk-provisioning event; this VTID added the missing deploy pipeline on top | No public ALB/DNS — outbound to LiveKit Cloud; verify via ECS `healthStatus` (`/alive`) | `AWS-PROD-DEPLOY-ORB-AGENT.yml` |
| autopilot-executor | VTID-03415 | No ECS service — Cloud-Run-Job equivalent. Task def family `vitana-autopilot-executor`, dispatched per-execution via `ecs:RunTask` from `dispatchExecutorJobAws()` (`services/gateway/src/services/aws-ecs-admin.ts`), selected by `DEV_AUTOPILOT_JOB_CLOUD=aws\|gcp` env var (default `gcp`) | N/A — no long-running service to curl | `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` — build+push+register only, no service to roll; the next RunTask dispatch picks up the new `:LATEST` revision automatically |

Shared infra across all of the above:

| Item | Value |
|---|---|
| AWS account / region | `472838866351` / `eu-central-1` |
| ECS cluster | `Vitana-ECS-Cluster` (shared with AWS staging) |
| Database | RDS Aurora PostgreSQL `vitana-aurora-prod` (writer/reader), same Supabase project as GCP prod (`inmkhvwdcuyhnxkgfvsb`) |
| Redis | ElastiCache `vitana-redis-prod` |
| ALB | `vitana-alb-prod` — all host-header rules sit **below** priority 10 (see hard rule below) |
| Deploy auth | GitHub OIDC federation, `AWS_PROD_ROLE_ARN` (all except community-app's frontend workflow — see its row above) |
| Deploy trigger | Every `AWS-PROD-DEPLOY-*.yml` is `workflow_dispatch`-only, required `reason`, never on push |
| Command Hub PUBLISH target | `PUBLISH_TARGET_CLOUD=aws` (gateway env var, VTID-03420, default `gcp`) switches the PUBLISH button to promote **AWS staging → AWS prod**: `POST /publish` resolves the commit `vitana-gateway` staging actually serves (HTTP build-info, never ECS status) and dispatches `AWS-PROD-DEPLOY-GATEWAY.yml` in `promote-staging` mode with `expected_commit` pinned — the exact tested ECR image ships, no rebuild. `/operator/revisions` for the two gateway rows is likewise build-info-backed (Cloud Run APIs have no credentials on ECS). `GCP_DUAL_PUBLISH_ENABLED=true` (default off) additionally refreshes the GCP rollback target via EXEC-DEPLOY with the same commit. With the var unset/`gcp`, the original GCP flow is untouched (where `AWS_DUAL_PUBLISH_ENABLED=true` still best-effort dispatches the AWS workflow — legacy leg, rebuilds `main`). |

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

**Full production cutover (GCP→AWS) is a separate, larger action from any
per-service DR build above — never assume it's authorized by this
section.** The runbook, go/no-go checklist, DNS repoint sequence, and
rollback plan live in `docs/AWS-CUTOVER-RUNBOOK.md` (VTID-03412). That
document does not itself authorize a cutover; it's the prerequisite a
future execution VTID must reference and satisfy before any
`gateway.vitanaland.com`/apex DNS record is touched.

### Hard rules specific to AWS-DR prod

- **Never** deploy to AWS-DR prod on push — `AWS-PROD-DEPLOY-GATEWAY.yml`
  has no `on: push` trigger. It mirrors the GCP staging-first model
  (§16): AWS staging (`vitana-gateway`) auto-deploys on push; AWS prod
  (`vitana-gateway-awsdr`) is a deliberate manual dispatch with a
  recorded reason, same spirit as the GCP PUBLISH button /
  `publish-to-prod.sh` escape hatch. The Command Hub PUBLISH button MAY
  also dispatch it (via `workflow_dispatch`, never push) when
  `AWS_DUAL_PUBLISH_ENABLED=true` — that is still a deliberate dispatch
  triggered by an admin's PUBLISH click, not an automatic push trigger.
- **Never** confuse `vitana-gateway` (AWS staging) with
  `vitana-gateway-awsdr` (AWS DR prod) — same ECS cluster, similarly
  named. The `vitana-alb-prod` ALB's target group named
  `vitana-tg-gateway-prod` is a **pre-existing naming leftover that
  actually serves staging traffic**, not AWS-DR prod — verify via
  `/api/v1/admin/health`'s `env` field before trusting a resource name.
  The owning IaC is `exafyltd/vitana-infra` (private repo, TMC migration
  handover — found 2026-07-31, was not previously cross-referenced from
  this repo): `terraform/phase5-compute/alb.tf` (`environment="prod"`)
  vs `terraform/phase4-ecs` (`environment="staging"`), reconciled by
  pointing staging's ECS services at the "prod"-named target groups
  during a 2026-07-16/17 outage fix. **That repo's own README says "DO
  NOT terraform apply YET"** — its checked-in state is stale vs. live
  infra; see `docs/AWS-CUTOVER-RUNBOOK.md` §1 for the full finding
  before anyone runs `terraform plan`/`apply` there.
- **IF** adding another host-header listener rule to `vitana-alb-prod` →
  **THEN** give it priority < 10 — the ALB's existing path-based rules
  (`/api/*`, `/ws/*` at priority 10) match before higher-numbered
  host-header rules regardless of `Host`, and will silently route to
  staging otherwise (see the build log's "ALB listener-rule priority"
  section for how this bit the initial build).
- **Never** assume a service not listed in the §1b table has AWS-DR
  infrastructure. As of VTID-03415, gateway, community-app,
  oasis-operator, oasis-projector, worker-runner, verification-engine,
  orb-agent, and the autopilot-executor RunTask path are all built out
  (see the table). Extending to any other service — including the
  ~17-22 unexplained "mystery services" from the 2026-07-09
  bulk-provisioning event (see the build log's "Legacy/mystery
  services" section) — still needs its own new VTID.
- **Never** assume a running AWS resource is governed just because it
  exists. `orb-agent`'s ECS service and task definition predated
  VTID-03414 (part of the same unexplained 2026-07-09 bulk-provisioning
  event) — VTID-03414 only added the missing `AWS-PROD-DEPLOY-*.yml`
  deploy pipeline on top of what was already silently running. Check for
  a matching deploy workflow before trusting that a live service reflects
  `main`.
- **Never** autoscale `oasis-projector`, `worker-runner`, or
  `verification-engine` without a real concurrency-safety review first —
  `oasis-projector`'s Ledger Writer has no cross-instance locking at all,
  and CLAUDE.md's own "Never run parallel VTID executions" rule cuts
  against guessing `worker-runner` is safe at N>1. Fixed `desiredCount`
  and no public ALB/DNS for all three is deliberate, not an oversight.
- GitHub OIDC federation (no static AWS keys) is required for the prod
  deploy role, mirroring `scripts/aws/README.md`'s pattern — **never**
  add a static-key IAM user for AWS-DR prod deploys the way AWS staging
  did (`claude-staging-validation`; a known shortcut, not to be repeated).
  The community-app frontend workflow (VTID-03409) is a documented,
  temporary exception — see its §1b table row.

---

## 2. SERVICES ARCHITECTURE

### Deployable Services (Cloud Run)
| Service | Source Path | Cloud Run Name |
|---------|-------------|----------------|
| Gateway | `services/gateway/` | `gateway` |
| OASIS Operator | `services/oasis-operator/` | `oasis-operator` |
| OASIS Projector | `services/oasis-projector/` | `oasis-projector` |
| Verification Engine | `services/agents/vitana-orchestrator/` | `vitana-verification-engine` |
| Worker Runner | `services/worker-runner/` | `worker-runner` |

### Non-Deployable Services (Libraries/Local)
- `services/agents/` - Agent implementations
- `services/mcp/` - MCP protocol
- `services/mcp-gateway/` - MCP gateway
- `services/deploy-watcher/` - Deploy watcher
- `services/oasis/` - OASIS core
- `services/validators/` - Validators

### Service Path Map
Located at: `config/service-path-map.json`

---

## 2b. LLM ROUTING — BEDROCK PROVIDER (VTID-03403)

The gateway's LLM dispatcher (`services/gateway/src/services/llm-router.ts`)
selects a provider per-*stage* from the DB-backed `llm_routing_policy` table
(editable via the Command Hub dropdown), via an `ADAPTERS: Record<LLMProvider,
ProviderAdapter>` map. **Anthropic Claude via Amazon Bedrock (`'bedrock'`) is
one of these adapters**, alongside `anthropic`, `openai`, `vertex`,
`deepseek`, and `claude_subscription`.

- **Region:** `eu-central-1` — the only region with any Vitana AWS
  infrastructure for account `472838866351` (confirmed via
  `scripts/aws-staging-validation/reports/aws-run-20260716/FINDINGS.md`).
  Read from `AWS_BEDROCK_REGION` (falls back to `AWS_REGION`, then
  `us-east-1`).
- **Activation gate:** `BEDROCK_ROLE_ARN` env var. Unset → the adapter
  reports itself unavailable (`not_configured`) and the router skips it like
  any other provider with missing credentials. Setting it in
  `gateway-staging` is a deliberate, separate action — not a byproduct of
  deploying this code.
- **Model selection:** `ADAPTERS.bedrock.call()` takes the model string
  straight from whatever the active stage's `llm_routing_policy` row
  specifies — for Bedrock this must be a resolved **cross-region inference
  profile ID** (e.g. `eu.anthropic.claude-sonnet-4-6-v1:0`), not a bare
  on-demand model ID. `PROVIDER_FLAGSHIPS.bedrock`
  (`services/gateway/src/constants/llm-defaults.ts`) is only the Command Hub
  dropdown's convenience default — read from `BEDROCK_MODEL_ID` if set.
- **Not selected by default anywhere.** Adding the adapter does not change
  any stage's routing — Bedrock only runs when an operator explicitly points
  a stage at `'bedrock'`.
- **Vision and tool calling ARE supported (VTID-03496).** `image`/`images`
  become Anthropic content blocks and `tools`/`forceTool` become `tools` +
  `tool_choice`, built identically to `anthropicAdapter` — Bedrock speaks the
  same Messages API wire shape (`anthropic_version: 'bedrock-2023-05-31'`), so
  there is deliberately only one serializer shape to reason about. A `tool_use`
  response block surfaces as `AdapterResult.toolCall`. This is what makes
  `anthropic-vision-client.ts` (Shorts auto-metadata — images + a forced
  `emit_short_metadata` call) routable to Bedrock. Text-only calls still send a
  plain string `content`, byte-identical to the VTID-03403 behaviour.
- **Two latent bugs fixed in the same VTID, worth knowing about:**
  (1) `tools` was declared on `BedrockInvokeRequest` but never serialized into
  the request body — a caller passing tools got a plain completion, no tool
  call and no error. (2) Response text was read from `content[0].text`, which
  is **empty whenever a forced `tool_use` block comes first** — i.e. it would
  have failed on every vision call. Both are covered by tests.
- `BEDROCK_ROLE_ARN`/region are now read **at call time**, not module load, so
  setting the var on a task definition takes effect without a process restart.
- **Implementation:** `services/gateway/src/providers/bedrock.ts`
  (`invokeBedrock()`) does the actual `BedrockRuntimeClient.send()` call;
  `bedrockAdapter` in `llm-router.ts` adapts it to the router's
  `ProviderAdapter` interface. Provider/model/latency logging comes for
  free via the router's existing `startLLMCall`/`completeLLMCall`/
  `failLLMCall` telemetry — no Bedrock-specific logging code needed.

---

## 2c. TTS — AMAZON POLLY PROVIDER (VTID-03495)

Build 1 of the 4 provider replacements that must exist before any GCP
shutdown is possible (Polly → Titan image gen → Bedrock vision/tool-calling →
Nova Sonic promotion).

All Google Cloud TTS synthesis now routes through one seam,
`services/gateway/src/services/tts/tts-provider.ts`, selected by
**`TTS_PROVIDER=google|polly`, default `google`** — same deliberate-opt-in
shape as `BEDROCK_ROLE_ARN` (§2b) and `DEV_AUTOPILOT_JOB_CLOUD` (§1b).
**Deploying this code changes nothing.** An unrecognised value logs and falls
back to `google` rather than failing closed and taking voice down.

| Call site | File | Format | Behaviour |
|---|---|---|---|
| ORB greeting bridge | `services/tts/greeting-bridge-tts.ts` | PCM | Polly-first when configured |
| Reminder pre-render | `services/reminder-tts.ts` | MP3 | Polly-first when configured |
| ORB `/tts` route | `routes/orb-live.ts` (~L13920) | MP3 | Polly-first when configured |
| Admin voice preview | `routes/voice-config.ts` | MP3 | **Explicit `provider:'polly'` body param only** — deliberately ignores `TTS_PROVIDER` so a preview never lies about what it played |
| Cloud TTS debug route | `routes/orb-live.ts` (~L12676) | MP3 | **Google only, on purpose** — it is a Cloud-TTS diagnostic |

### Three hard facts about Polly that bit this build

1. **Polly has no Serbian voice, in any engine.** `sr` is a live locale here
   (§13b lists DE/EN/ES/SR). `resolvePollyVoice('sr')` returns **null** and the
   caller falls back to Google — it does **not** substitute English. Fluent
   audio in the wrong language is worse than no audio, because nothing
   downstream can detect it. **This is an unresolved coverage gap for a full
   GCP shutdown**: with GCP gone, Serbian users get no TTS at all.
2. **Polly PCM is 8kHz/16kHz only — it cannot do the 24kHz** the greeting
   bridge used. `synthesizeGreetingBridgeAudioPcm()` therefore returns
   `{ audioB64, sampleRateHz }` instead of a bare string, and `orb-live.ts`
   builds `audio/pcm;rate=` from that value. Hardcoding 24kHz under Polly
   plays 16kHz samples 1.5× fast — obvious to a listener, invisible to any
   test that only asserts bytes came back.
3. **Polly has no `speakingRate` field.** Rate becomes SSML
   `<prosody rate="N%">`, which forces `TextType:'ssml'` and XML-escaping. At
   rate 1.0 plain text is sent, avoiding the escaping surface entirely.

Also note Polly's Russian is **standard-engine only** (no neural voice) — a
quality step down from `ru-RU-Wavenet-A`.

### Fallback is never silent

`TTS_PROVIDER=polly` + an unservable request → falls back to Google **with a
`[TTS] FALLBACK polly→google` log line**, per "Never allow silent model
fallback". Set **`TTS_POLLY_STRICT=true`** to disable the fallback — use it in
a GCP-shutdown rehearsal to prove no hidden Google dependency remains; with it
on, an unservable request returns null instead of quietly reaching back to GCP.

### Before flipping `TTS_PROVIDER=polly`

The voice/engine table and the Serbian gap were derived from Polly's
documented voice list and **not verified against the live API** — the session
that built this had no working AWS credentials. Confirm against
`aws polly describe-voices` first, and note Polly needs IAM `polly:SynthesizeSpeech`
on the gateway task role (`AWS_POLLY_REGION`, else `AWS_REGION`, else
`eu-central-1`).

---

## 3. DATABASE (SUPABASE)

### Critical Rules
1. **PostgreSQL tables MUST use `snake_case`** (vtid_ledger, oasis_events)
2. **TypeScript code MUST reference EXACT table names**
3. **Check DATABASE_SCHEMA.md before creating any table**

### Core Tables
| Table | Purpose |
|-------|---------|
| `vtid_ledger` | Central VTID task tracking |
| `oasis_events` | System-wide event log |
| `personalization_audit` | Cross-domain personalization audit |
| `services_catalog` | Service catalog |
| `products_catalog` | Product catalog |
| `d44_predictive_signals` | Proactive intervention signals |
| `contextual_opportunities` | D48 opportunity surfacing |
| `risk_mitigations` | D49 risk mitigation |

### vtid_ledger Key Columns
| Column | Type | Values |
|--------|------|--------|
| `vtid` | TEXT | Primary key (VTID-XXXXX format) |
| `status` | TEXT | scheduled, in_progress, completed, pending, blocked, cancelled |
| `spec_status` | TEXT | draft, pending_approval, approved, rejected |
| `is_terminal` | BOOLEAN | Task completion flag |
| `terminal_outcome` | TEXT | success, failed, cancelled |
| `claimed_by` | TEXT | Worker ID that claimed the task |
| `claimed_until` | TIMESTAMPTZ | Claim expiration |

### DEPRECATED - DO NOT USE
- `VtidLedger` (PascalCase) - Empty, use `vtid_ledger`

---

## 4. VTID SYSTEM

### 4.1 Self-Service Allocation (STANDING RULE — VTID-03448)

**This question is permanently settled. Do not re-ask the user "should this
have a VTID" or "do you have a VTID for this" ever again.** Every task gets
one, Claude allocates it itself, first step, no exceptions.

Procedure, in order of preference:

1. **Gateway API** (preferred when the gateway is reachable from the
   session): `POST /api/v1/vtid/allocate` with `{ source, layer, module }`
   (see §11 for URL resolution). Returns `{ vtid, num, id }`.
2. **Direct Supabase RPC** (when the gateway isn't reachable, e.g. a
   Claude Code session without a live gateway endpoint): call
   `allocate_global_vtid(p_source, p_layer, p_module)` via the Supabase
   MCP/CLI against the `VITANA` project. Returns the same shape.
3. Either path atomically mints the next `VTID-XXXXX` and creates the
   ledger shell row in one transaction — allocated and registered can
   never split.
4. Immediately follow up with an `UPDATE vtid_ledger` (or the equivalent
   gateway PATCH) to set a real `title`/`summary`/`description` (never
   leave the "Allocated - Pending Title" placeholder), and set
   `status='in_progress'` + `spec_status='approved'` when the user has
   directly instructed the work in the current conversation.
5. **If the allocator itself is disabled** (`VTID_ALLOCATOR_ENABLED`
   false and no DB override) — that's the one real stop condition. Tell
   the user allocation is blocked and why; do not fabricate a VTID
   number and do not silently proceed without one.
6. One VTID per distinct piece of work. Two unrelated fixes requested in
   the same message get two VTIDs, not one shared across both.

### VTID Format
- Pattern: `VTID-XXXXX` (5 digits, zero-padded)
- Example: `VTID-01200`

### Target Roles (VTID-01010)
```typescript
const TARGET_ROLES = ['DEV', 'COM', 'ADM', 'PRO', 'ERP', 'PAT', 'INFRA'] as const;
```
- `INFRA` must be exclusive (cannot combine with others)

### Task Lifecycle
```
scheduled → in_progress → [claimed] → [executing] → completed/failed
                                                   ↓
                                            is_terminal=true
                                            terminal_outcome=success|failed|cancelled
```

### Task Eligibility (for worker execution)
A task is eligible when:
1. `status === 'in_progress'`
2. `spec_status === 'approved'`
3. `is_terminal === false`
4. `claimed_by === null` OR `claimed_by === this_worker`

---

## 5. GOVERNANCE

### Hard Governance Rules
1. **EXECUTION_DISARMED** - Global kill switch for autonomous execution
2. **AUTOPILOT_LOOP_ENABLED** - Controls autopilot polling
3. **VTID_ALLOCATOR_ENABLED** - Controls VTID allocation
4. One VTID at a time per worker (no parallel execution)
5. Memory-first (workers don't write to DB directly)
6. Idempotent completion (safe to call complete multiple times)

### Governance Endpoints
- `POST /api/v1/governance/evaluate` - Evaluate governance for action
- `GET /api/v1/governance/status` - Get governance status

### Bypass Header (Emergency Only)
```
X-BYPASS-ORCHESTRATOR: EMERGENCY-BYPASS
```

---

## 6. OASIS EVENTS

### Event Taxonomy
| Category | Examples | When to Emit |
|----------|----------|--------------|
| `vtid.lifecycle.*` | started, completed, failed | State changes |
| `vtid.stage.*` | planner.started, worker.success | Stage transitions |
| `vtid.decision.*` | claimed, released, retried | Decisions |
| `vtid.error.*` | failed, blocked | Errors |
| `telemetry.*` | heartbeat, polled | **NEVER to OASIS** |

### Critical Rule
> **OASIS is for STATE TRANSITIONS and DECISIONS — not loops.**
> Polling ≠ progress. Heartbeat ≠ event. Repetition ≠ signal.

### Event Schema
```typescript
{
  id: UUID,
  type: string,          // Event type (e.g., vtid.lifecycle.completed)
  topic: string,         // Event topic/category
  source: string,        // Service name
  vtid: string,          // Associated VTID
  service: string,
  status: string,        // info, success, warning, error
  message: string,
  payload: JSONB,
  created_at: TIMESTAMPTZ
}
```

---

## 7. WORKER ORCHESTRATOR API

### Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/worker/orchestrator/register` | Register worker |
| DELETE | `/api/v1/worker/orchestrator/register/:id` | Deregister worker |
| GET | `/api/v1/worker/orchestrator/workers` | List workers |
| GET | `/api/v1/worker/orchestrator/tasks/pending` | Get pending tasks |
| POST | `/api/v1/worker/orchestrator/claim` | Claim a task |
| POST | `/api/v1/worker/orchestrator/release` | Release a claim |
| POST | `/api/v1/worker/orchestrator/route` | Route to subagent |
| POST | `/api/v1/worker/orchestrator/heartbeat` | Send heartbeat |
| POST | `/api/v1/worker/subagent/start` | Report subagent start |
| POST | `/api/v1/worker/subagent/complete` | Report subagent complete |
| POST | `/api/v1/worker/orchestrator/complete` | Report orchestrator complete |
| POST | `/api/v1/worker/orchestrator/terminalize` | Terminalize VTID |

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
# One-button-both publish (workstream C): cross-repo token + repo for promoting
# the frontend (community-app) from the Command Hub PUBLISH button. Without
# FRONTEND_DEPLOY_TOKEN the gateway still publishes, and the response reports
# frontend_promote.ok=false with a "token not set" detail (deploy frontend manually).
FRONTEND_DEPLOY_TOKEN=<PAT with actions:write on exafyltd/vitana-v1>
FRONTEND_DEPLOY_REPO=exafyltd/vitana-v1
# AWS dual-publish (VTID-03398): when 'true', the Command Hub PUBLISH button
# also best-effort dispatches AWS-PROD-DEPLOY-GATEWAY.yml with the same
# commit, after the GCP EXEC-DEPLOY dispatch. Default OFF — AWS-PROD-DEPLOY-
# GATEWAY.yml was deliberately built workflow_dispatch-only with a required
# human-entered reason so AWS prod deploys stay a deliberate action; this
# flag trades that off for one-click dual-publish. GCP remains canonical
# regardless of this flag — see §1b. Failure on the AWS leg never fails the
# publish (response reports aws_promote.ok=false with detail).
AWS_DUAL_PUBLISH_ENABLED=true|false
# VTID-03420: which cloud the Command Hub PUBLISH button promotes. 'aws' =
# promote AWS staging (vitana-gateway) → AWS prod (vitana-gateway-awsdr) by
# exact-image promotion (AWS-PROD-DEPLOY-GATEWAY.yml promote-staging mode,
# expected_commit pinned); default 'gcp' = original gateway-staging →
# gateway Cloud Run flow. Set 'aws' on the AWS task defs post-VTID-03419.
PUBLISH_TARGET_CLOUD=aws|gcp
# VTID-03420 (only used when PUBLISH_TARGET_CLOUD=aws): when 'true', PUBLISH
# also best-effort ships the same commit to GCP Cloud Run via EXEC-DEPLOY so
# the standing rollback target stays fresh. Default off — mirror image of
# AWS_DUAL_PUBLISH_ENABLED's deliberate-action tradeoff.
GCP_DUAL_PUBLISH_ENABLED=true|false
GOOGLE_CLOUD_PROJECT=lovable-vitana-vers1
GCP_PROJECT=lovable-vitana-vers1
VERTEX_LOCATION=us-central1
VERTEX_MODEL=gemini-2.5-pro
GEMINI_API_KEY=xxx
OPENAI_API_KEY=xxx
```

---

## 9. CI/CD WORKFLOWS

### Key Workflows
| File | Purpose |
|------|---------|
| `EXEC-DEPLOY.yml` | Canonical deployment (VTID governance) |
| `MCP-GATEWAY-CI.yml` | MCP Gateway CI |

### Deployment Requirements
1. VTID must exist in OASIS ledger before deploy (VTID-0542)
2. Governance evaluation must pass (VTID-0416)
3. All deploys go through governed CI pipeline

---

## 10. CODING CONVENTIONS

### TypeScript
- Use strict types
- Use Zod for validation
- Use Express Router pattern

### API Patterns
- All API routes under `/api/v1/`
- Use snake_case for JSON response fields
- Return `{ ok: boolean, error?: string, data?: T }`

### File Organization
```
services/<service>/
  src/
    index.ts           # Entry point
    types.ts           # TypeScript types
    routes/            # API routes
    services/          # Business logic
  Dockerfile
  package.json
  tsconfig.json
```

---

## 11. QUICK REFERENCE

### Get Gateway URL
```bash
gcloud run services describe gateway \
  --region=us-central1 \
  --project=lovable-vitana-vers1 \
  --format="value(status.url)"
```

### Deploy a Service
```bash
cd services/<service>
gcloud builds submit \
  --tag us-central1-docker.pkg.dev/lovable-vitana-vers1/cloud-run-source-deploy/<service>:latest \
  --project lovable-vitana-vers1
gcloud run deploy <service> \
  --image us-central1-docker.pkg.dev/lovable-vitana-vers1/cloud-run-source-deploy/<service>:latest \
  --region us-central1 \
  --project lovable-vitana-vers1
```

### Check Service Logs
```bash
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=<service>" \
  --project lovable-vitana-vers1 \
  --limit 50
```

---

## 12. DOCUMENT REFERENCES

| Document | Purpose |
|----------|---------|
| `DATABASE_SCHEMA.md` | Canonical database schema reference |
| `config/service-path-map.json` | Service to path mapping |
| `.github/workflows/EXEC-DEPLOY.yml` | Deployment workflow |
| `docs/MOBILE_DEVICE_TESTING.md` | Device-level frontend testing (sim-use: iOS Simulator / Android) |

---

## 13. VTID REFERENCES IN THIS CODEBASE

Key VTIDs that established patterns:
- **VTID-0416** - Gateway Deploy Governance Lockdown
- **VTID-0542** - VTID Allocator Hard Gate
- **VTID-01010** - Target Role System
- **VTID-01032** - Multi-service Auto-deploy
- **VTID-01181** - DB-backed Allocator Toggle
- **VTID-01187** - Execution Governance Defense in Depth
- **VTID-01200** - Worker-Runner Execution Plane

---

## 13b. SERVER-SIDE i18n (PR #2269)

The gateway emits some strings directly to users (push notifications, email
subjects, voice greetings, error bodies) where the frontend can't intercept
and translate. The German community has been complaining about English text
showing on their lock screen — this is the surface that causes it.

### Hard rule

**Never** hardcode a user-visible string in a gateway response. Use the
catalog:

```ts
import { tt, type GatewayI18nKey } from '../i18n/catalog';
import { getUserLocale, bulkGetUserLocales } from '../i18n/server-locale';

// Single user
const lc = await getUserLocale(supa, user_id);
title: tt('notif.diary_reminder.title', lc),
body:  tt('notif.diary_reminder.body', lc, { count: 3 }),

// Cron fan-out (many users)
const locales = await bulkGetUserLocales(supa, userIds);
for (const u of users) {
  const lc = locales.get(u.user_id);
  await notify(u.user_id, tt('notif.x.title', lc), tt('notif.x.body', lc));
}
```

### Adding a new key

1. Add the key to `GatewayI18nKey` union in `services/gateway/src/i18n/catalog.ts`.
2. Add translations to **all four** locale objects (DE, EN, ES, SR). DE
   must be a real translation; ES/SR can start as a copy of EN and graduate
   through the audit workflow later.
3. Use `tt(key, locale, params?)` in the route handler.

### Locale resolution priority

1. `app_users.locale` (canonical)
2. `memory_facts.fact_key='preferred_language'` (fallback)
3. `'de'` (default)

5-min in-process cache. Cron jobs that fan out over thousands of users
must use `bulkGetUserLocales` to batch-fetch in one query.

### What does NOT need translation

- **System instructions sent to the LLM** (`buildLiveSystemInstruction`,
  agent personas, tool prompts) — the LLM reads English instructions and
  emits German output when told `Respond ONLY in {language}`. Translating
  system prompts hurts model performance.
- **Internal state identifiers** (currency codes, tab IDs, status enums) —
  these are not user-visible.
- **Debug/telemetry logs** — never translated.

---

---

## 14. MEMORY & INTELLIGENCE ARCHITECTURE (VTID-01225)

This section documents the complete Memory & Intelligence stack, including how data flows from input (ORB/Operator Console) through extraction, storage, and retrieval for personalized responses.

### Data Input Channels

| Channel | Technology | Entry Point |
|---------|------------|-------------|
| **ORB Voice** | Gemini Live API v2 (WebSocket) | `orb-live.ts` |
| **Operator Console** | REST API (Text/Tasks) | `conversation.ts` |

### Memory Garden Categories (13 Total)

| Category Key | Display Name | Source Mappings |
|--------------|--------------|-----------------|
| `personal_identity` | Personal Identity | personal_identity |
| `health_wellness` | Health & Wellness | health |
| `lifestyle_routines` | Lifestyle & Routines | preferences |
| `network_relationships` | Network & Relationships | relationships, community, events_meetups |
| `learning_knowledge` | Learning & Knowledge | learning, education, skills |
| `business_projects` | Business & Projects | tasks |
| `finance_assets` | Finance & Assets | products_services |
| `location_environment` | Location & Environment | location, travel |
| `digital_footprint` | Digital Footprint | digital, online |
| `values_aspirations` | Values & Aspirations | goals |
| `autopilot_context` | Autopilot & Context | autopilot |
| `future_plans` | Future Plans | plans, milestones |
| `uncategorized` | Uncategorized | conversation, notes |

### Process Flow (Sync - User Response Path)

```
User Input (ORB/Operator)
       │
       ▼
┌──────────────────────────────────────────┐
│  1. Write raw conversation               │
│     writeMemoryItemWithIdentity()        │
│     → memory_items (category: conv)      │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  2. Retrieval Router (D2)                │
│     retrieval-router.ts                  │
│                                          │
│     Rules (priority order):              │
│     • vitana_system (100) → Knowledge    │
│     • personal_history (90) → Memory     │
│     • health_personal (85) → Memory      │
│     • external_current (80) → Web        │
│     • general_knowledge (50) → Knowledge │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  3. Context Pack Builder                 │
│     buildContextPack() /                 │
│     buildBootstrapContextPack()          │
│                                          │
│     Sources:                             │
│     • Memory Garden (fetchDevMemory)     │
│     • Knowledge Hub (searchKnowledge)    │
│     • Web Search (disabled in bootstrap) │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  4. LLM Generation (Gemini)              │
│                                          │
│     System Instruction includes:         │
│     - User context from memory           │
│     - Personalization data               │
│     - Domain-specific knowledge          │
└──────────────────────────────────────────┘
       │
       ▼
   Response to User
```

### Process Flow (Async - Extraction & Persistence)

```
Session End / Conversation Complete
       │
       ▼
┌──────────────────────────────────────────┐
│  1. Cognee Extraction                    │
│     cogneeExtractorClient.extractAsync() │
│                                          │
│     Extracts:                            │
│     • PERSON entities                    │
│     • DATE entities                      │
│     • LOCATION entities                  │
│     • RELATIONSHIP entities              │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  2. Persist Extraction Results           │
│     persistExtractionResults()           │
│                                          │
│     A. RELATIONSHIP GRAPH (VTID-01087)   │
│        → relationship_ensure_node() RPC  │
│        → relationship_nodes table        │
│                                          │
│     B. MEMORY FACTS (VTID-01192)         │
│        → write_fact() RPC                │
│        → memory_facts table              │
│        → Semantic keys: user_name,       │
│          user_birthday, fiancee_name     │
│        → Provenance: assistant_inferred  │
│        → Auto-supersession built-in      │
│                                          │
│     C. MEMORY ITEMS (Legacy)             │
│        → Direct INSERT                   │
│        → memory_items table              │
│        → Uses source category mapping    │
└──────────────────────────────────────────┘
```

### Database Schema (Memory & Intelligence)

```
┌─────────────────────────────────────────────────────────────────┐
│                      MEMORY GARDEN                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  memory_facts (VTID-01192)     memory_items (VTID-01104)       │
│  ┌──────────────────────┐      ┌──────────────────────┐        │
│  │ fact_key             │      │ category_key         │        │
│  │ fact_value           │      │ content              │        │
│  │ entity (self/discl)  │      │ content_json         │        │
│  │ provenance_source    │      │ importance           │        │
│  │ provenance_confidence│      │ embedding (pgvector) │        │
│  └──────────────────────┘      └──────────────────────┘        │
│                                         │                       │
│                          memory_category_mapping                │
│                          ┌──────────────────────┐               │
│                          │ source → garden      │               │
│                          │ health → health_well │               │
│                          │ tasks → business_proj│               │
│                          └──────────────────────┘               │
│                                                                 │
│  memory_garden_config (13 categories)                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ personal_identity, health_wellness, lifestyle_routines,  │   │
│  │ network_relationships, learning_knowledge, business_proj, │   │
│  │ finance_assets, location_environment, digital_footprint, │   │
│  │ values_aspirations, autopilot_context, future_plans,     │   │
│  │ uncategorized                                             │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                   RELATIONSHIP GRAPH (VTID-01087)               │
├─────────────────────────────────────────────────────────────────┤
│  relationship_nodes → relationship_edges → relationship_signals │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ node_type       │  │ from_node_id    │  │ signal_type     │  │
│  │ display_name    │  │ to_node_id      │  │ signal_value    │  │
│  │ metadata        │  │ relation_type   │  │ computed_at     │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `services/gateway/src/services/cognee-extractor-client.ts` | Cognee extraction + persistence |
| `services/gateway/src/services/retrieval-router.ts` | Routing decisions for context sources |
| `services/gateway/src/services/context-pack-builder.ts` | Builds context pack for LLM |
| `services/gateway/src/services/orb-memory-bridge.ts` | Memory read/write bridge |
| `services/gateway/src/routes/orb-live.ts` | ORB Live API session handling |
| `supabase/migrations/20260119000000_vtid_01192_infinite_memory_v2.sql` | memory_facts + write_fact() |
| `supabase/migrations/20260203000000_vtid_01225_extend_memory_category_mapping.sql` | Extended 13 categories |

### Retrieval Router Rules

| Rule Name | Priority | Triggers | Primary Source |
|-----------|----------|----------|----------------|
| `vitana_system` | 100 | "vitana", "oasis" | Knowledge Hub |
| `personal_history` | 90 | "remember", "my name", "told you" | Memory Garden |
| `health_personal` | 85 | "my health", "my sleep" | Memory Garden |
| `external_current` | 80 | "news", "weather", "stock price" | Web Search |
| `general_knowledge` | 50 | "what is", "how to" | Knowledge Hub |

### write_fact() RPC (VTID-01192)

```sql
write_fact(
  p_tenant_id UUID,
  p_user_id UUID,
  p_fact_key TEXT,           -- Semantic key: user_name, user_birthday, fiancee_name
  p_fact_value TEXT,         -- The value: "Dragan Alexander", "September 9, 1969"
  p_entity TEXT,             -- 'self' or 'disclosed'
  p_fact_value_type TEXT,    -- 'text', 'date', 'number'
  p_provenance_source TEXT,  -- 'user_stated', 'assistant_inferred'
  p_provenance_confidence FLOAT -- 0.0 to 1.0
) RETURNS UUID
```

**Features:**
- Auto-supersession: New fact with same key replaces old
- Provenance tracking: Source and confidence stored
- Entity scope: Distinguishes user facts vs facts about others

### Critical Fix (VTID-01225)

**Before:** `extractAsync()` called Cognee, logged results, then **dropped them**
**After:** `extractAsync()` calls Cognee, then **persists to 3 storage systems**:
1. `relationship_nodes` via `relationship_ensure_node()` RPC
2. `memory_facts` via `write_fact()` RPC
3. `memory_items` for legacy retrieval compatibility

---

## 15. DEPLOYMENT VERIFICATION PROTOCOL (VTID-01228)

**This is mandatory for EVERY deployment. No exceptions.**

Deployments have repeatedly failed because Cloud Shell had stale code, or the wrong branch was deployed. This protocol prevents that.

> **Staging-first note (effective Mon 8 Jun 2026, 10:00 Europe/Berlin):** from
> the cutover instant you are by default verifying **STAGING**
> (`gateway-staging` / `preview-gateway.vitanaland.com`), because pushes to
> `main` auto-deploy staging only. The same curl/revision checks below apply —
> just point them at the staging URL and expect `env=staging`. You verify
> **production** only after a PUBLISH-button promotion or an escape-hatch
> (`scripts/deploy/publish-to-prod.sh`) / manual-dispatch deploy — never as a
> side effect of a push. (Before the cutover, pushes still reach prod.)

### Pre-Deploy Verification (BEFORE `gcloud builds submit`)

1. **Verify source code has the expected changes:**
   ```bash
   # Example: Verify sessions route exists before deploying Gateway
   grep -r "sessions" services/gateway/src/routes/live.ts | head -5
   ```
2. **If deploying from Cloud Shell, verify it's on latest main:**
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

### Post-Deploy Verification (AFTER `gcloud run deploy` succeeds)

1. **Curl a critical endpoint that only exists in the new code:**
   ```bash
   # Check content-type: must be application/json, NOT text/html
   curl -s -o /dev/null -w "%{http_code} %{content_type}" \
     -X POST "https://gateway-86804897789.us-central1.run.app/api/v1/live/rooms/test/sessions" \
     -H "Content-Type: application/json" -d '{}'
   # Expected: "401 application/json..." (auth required, but JSON = route exists)
   # FAILURE: "404 text/html..." (Express default = route does NOT exist)
   ```
2. **Check the /alive endpoint:**
   ```bash
   curl -s "https://gateway-86804897789.us-central1.run.app/alive"
   ```
3. **Check the latest revision is serving:**
   ```bash
   gcloud run revisions list --service=<service> \
     --region=us-central1 --project=lovable-vitana-vers1 --limit=3
   ```

### Key Diagnostic: HTML 404 vs JSON 404

| Response | Content-Type | Meaning |
|----------|-------------|---------|
| `Cannot POST /api/v1/...` | `text/html` | **Route does NOT exist** — wrong code deployed |
| `{"error":"ROOM_NOT_FOUND"}` | `application/json` | Route exists, business logic error — correct code |

### Failure Protocol

If post-deploy verification fails:
1. **Do NOT tell the user "deployment succeeded"** — it didn't
2. Check which revision is serving: `gcloud run revisions list`
3. Check the build logs in Cloud Console (CLI `gcloud builds log` has known bugs)
4. Verify the source that was submitted had the correct code

---

## 16. CI/CD DEPLOYMENT PIPELINE — STAGING-FIRST (Updated 2026-06-04)

**This section was rewritten for the staging-first cutover. READ CAREFULLY —
the old "merge to main → manually dispatch EXEC-DEPLOY to prod" flow is GONE.**

### The model: push freely → staging; one button → prod

The cutover is **time-gated** — it flips at **Mon 8 Jun 2026, 10:00
Europe/Berlin**. Before then, push still reaches prod; the table below
describes behavior **at/after** the cutover.

| Action | Where it lands | How |
|--------|----------------|-----|
| Push / merge to `main` (gateway) | **STAGING** (`gateway-staging`) | `STAGE-DEPLOY.yml`, automatic |
| Promote to **production** | `gateway` (+ frontend) | **PUBLISH button** in Command Hub |
| Exceptional manual prod deploy | single service | `scripts/deploy/publish-to-prod.sh` |

- **`STAGE-DEPLOY.yml`** auto-deploys staging on every push to `main` under
  `services/gateway/**`. Smoke-gates on `/api/v1/admin/health` → `env=staging`.
  Unaffected by the cutover — staging deploys always run.
- **`AUTO-DEPLOY.yml`** (and `DEPLOY-ORB-AGENT.yml`, `DEPLOY-AUTOPILOT-JOB.yml`,
  `VTID-02409-BOOTSTRAP.yml`) each carry a `cutover_gate` job. On a push
  **at/after** the cutover instant the prod path is frozen (auto = staging);
  **before** it, prod deploys as before. Their manual `workflow_dispatch`
  (which requires a `reason` on AUTO-DEPLOY) is **never** frozen — it is the
  deliberate prod lever. Prefer the escape-hatch script, which records the reason.
- **`EXEC-DEPLOY.yml`** is still the canonical governed prod deploy, driven by
  the PUBLISH button and the escape-hatch script (both `workflow_dispatch`).

### End-to-End Deployment Checklist (STAGING-FIRST)

When changing code:

1. **Code fix** — on the feature/`claude/` branch.
2. **Commit** — include a VTID (`(VTID-XXXXX)`) or `BOOTSTRAP-<description>`.
3. **Push** — to the `claude/` branch; open a PR.
4. **Merge to `main`** — this auto-deploys to **STAGING only**.
5. **Verify on staging** — `preview-gateway.vitanaland.com` (gateway) /
   `preview.vitanaland.com` (frontend). Confirm `env=staging`. Do **NOT**
   expect or look for a prod deploy here.
6. **Ship to production** — when staging is verified, click **PUBLISH** in the
   Command Hub (promotes the exact tested staging build). For the rare
   out-of-band case, run:
   ```
   scripts/deploy/publish-to-prod.sh --service gateway --vtid VTID-XXXXX \
     --reason "why this exceptional prod deploy is justified"
   ```
7. **Verify prod** — only after PUBLISH/escape-hatch, per §15.

### Do NOT auto-dispatch EXEC-DEPLOY to prod

The old habit was: merge to main, then manually `POST .../EXEC-DEPLOY.yml/dispatches`
to push prod. **That is no longer correct.** Merging deploys staging. Prod is a
deliberate, separate, governed action (PUBLISH button or escape-hatch script
with a recorded reason). If you find yourself hand-dispatching EXEC-DEPLOY to
prod as a routine step, you are reintroducing the auto-to-prod behavior this
cutover removed — stop.

### CSS/JS Cache-Busting

The Gateway serves static files with `Cache-Control: no-cache, no-store, must-revalidate`, so browser caching is NOT an issue. However, `index.html` has `?v=` parameters on CSS/JS links. **Always bump these version strings** when making frontend changes to be safe:
```html
<link rel="stylesheet" href="/command-hub/styles.css?v=YYYYMMDD-HHMM" />
<script src="/command-hub/app.js?v=YYYYMMDD-HHMM"></script>
```

### GitHub PATs for API Access

- **Vitana Platform**: `github_pat_11BI6FN3I0...` (use for PR creation, merging, workflow dispatch)
- **Lovable (Vitana v1)**: `ghp_vCNFyyrr...` (use for Lovable repo access)

Use these PATs with the GitHub REST API (`api.github.com`) for all PR and deployment operations.

---

## CHANGE LOG

| Date | Change | VTID |
|------|--------|------|
| 2026-08-05 | **Bedrock adapter: vision + forced tool-calling — build 2 of the 4 that gate a GCP shutdown.** Removes the blanket `images/tools not supported` rejection in `bedrockAdapter` (§2b). Bedrock speaks the same Anthropic Messages API wire shape, so images become content blocks and `tools`/`forceTool` become `tools` + `tool_choice`, mirrored line-for-line from `anthropicAdapter` so the two stay diffable; `tool_use` responses surface as `AdapterResult.toolCall`. This is the piece `anthropic-vision-client.ts` (Shorts auto-metadata) needed — images **and** a forced `emit_short_metadata` call, the exact combination previously rejected. **Two latent bugs found and fixed while building, both silent:** (1) `tools` was on `BedrockInvokeRequest` but never serialized into the body — passing tools produced a plain completion with no tool call and no error; (2) text was read from `content[0].text`, which is **empty when a forced `tool_use` block is first**, so it would have returned empty text on every vision call. Also moved `BEDROCK_ROLE_ARN`/region reads from module-load to call-time, so setting the var on a task def no longer needs a process restart (and can be tested). Text-only calls still send a plain string `content`, byte-identical to VTID-03403. Still dormant until `BEDROCK_ROLE_ARN` is set and an operator points a stage at `'bedrock'` — deploying this changes no routing. 9 new tests; full suite 619/619 suites, 12089 passed. | VTID-03496 |
| 2026-08-05 | **Amazon Polly TTS provider — build 1 of the 4 that gate a GCP shutdown.** New `services/tts/polly.ts` + `services/tts/tts-provider.ts` seam; all 4 Google Cloud TTS synthesis call sites route through it, selected by `TTS_PROVIDER=google\|polly` (**default `google` — deploying this flips nothing**). See §2c. Three Polly divergences that are NOT cosmetic: (1) **Polly has no Serbian voice in any engine** — `sr` is a live locale (§13b), so `resolvePollyVoice('sr')` returns null and falls back to Google rather than substituting English; with GCP gone, Serbian TTS has no provider at all, an unresolved shutdown blocker. (2) **Polly PCM is 8k/16k only, not 24k** — `synthesizeGreetingBridgeAudioPcm()` now returns `{audioB64, sampleRateHz}` and the `audio/pcm;rate=` mime is built from it; assuming 24kHz would play Polly audio 1.5× fast, audible to a user but invisible to a bytes-came-back test. (3) **No `speakingRate` field** — rate becomes SSML `<prosody>`, forcing XML-escaping (plain text kept at rate 1.0). Polly Russian is standard-engine only. Fallback polly→google is always logged; `TTS_POLLY_STRICT=true` disables it for shutdown rehearsals. The admin voice-preview route takes an explicit `provider:'polly'` param and deliberately ignores `TTS_PROVIDER` so previews can't lie; the Cloud-TTS debug route stays Google-only by design. **Voice table and the Serbian gap were derived from Polly's documented voice list, not verified against the live API** — the building session had no AWS credentials; confirm via `describe-voices` before flipping. 18 new tests. | VTID-03495 |
| 2026-08-05 | **Messenger history was never deleted — three independent caps made most of it unreachable, and one of them dropped whole conversations at random.** Reported as "the chat history is more or less completely gone." Nothing had been removed: `chat_messages` held 39,593 rows going back to 2026-02-27. (1) **The inbox itself was lossy.** `get_recent_conversations()` ends its `DISTINCT ON` pass with `ORDER BY peer_id, created_at DESC` — `DISTINCT ON` forces the ORDER BY to lead with the distinct key — and then applied `LIMIT p_limit` to *that*. So "the 50 most recent conversations" was really "50 conversations sorted by a random UUID": for the member with 199 conversations, only **7 of their 20 most-recently-active chats** were returned at all. Fixed by wrapping the `DISTINCT ON` result in an outer `ORDER BY created_at DESC LIMIT` (migration `20260805120000`), and raising the gateway's cap 50 → 250 (198 of 220 users have more than 50 conversations). (2) **Thread scrollback was dead code.** `ConversationView` renders `useHybridMessages`' React Query array, but its scroll-to-top handler drove `usePaginatedMessages` — a completely separate state array that was never rendered, and whose `fetchInitialMessages` was gated behind `shouldUsePagination` (`messages.length > 50` on that same always-empty array). Circular, so `hasOlder` was permanently `false` and scrolling up did nothing: every thread was frozen at its newest 50 messages, putting **15,444 of 39,593 messages (39%) permanently out of reach**. Replaced with real paging through the gateway's already-existing `before` cursor, accumulated per-thread OUTSIDE the query cache — realtime invalidation refetches that cache on every incoming message and would otherwise discard scrollback mid-conversation. (3) **Group threads and both DB fallbacks paged the wrong end.** `fetchLegacyMessages` and the `chat_messages` fallbacks used `.order('created_at', {ascending: true}).limit(100)`, which returns the OLDEST 100 rows — a busy group chat showed its first-ever 100 messages and never the recent ones. Now fetched newest-first and reversed for render. **Lesson worth keeping:** a `LIMIT` after `DISTINCT ON` is not "top N", it is "N arbitrary rows" — and dead pagination is invisible precisely because the first page always looks right. | VTID-03493 |
| 2026-08-03 | **`orb_session_state` never existed in production — four ORB features were silently dead for ~2 months.** Investigating a live report of ORB voice failing on mobile, every session was found to emit `orb.session.audio_ready.acked` with `ok:false`. That `ok` is not the client's readiness — it is the return of `writeOrbSessionState()`, and the write was failing because `relation "orb_session_state" does not exist`. Migration `20260606000000_DEV_COMHU_0503_orb_session_state.sql` was authored but never applied (its own header: "Not executed from the sandbox"); the applied-migrations list jumps `20260605…` → `20260609…`. Because every helper in `orb-session-state.ts` fails soft by design (reads → `null`, writes → `{ok:false}`, never throws), nothing surfaced: the **audio-ready handshake** (greeting fell back to a blind 3s timer and could be spoken before the client could play it — the silent-ORB symptom), **close/reopen continuity**, the **pending autopilot CTA**, and **wake-brief opener rotation** were all inert. Applied the migration to prod; `audio_ready.acked` flipped `ok:false` → `ok:true` on the next live session with **no redeploy**, confirming the code had always been calling it correctly. Session telemetry that made this findable: 29 sessions ended `expired_ttl` at ~32 min with `turn_count:0` and `audio_in_chunks:0` while `audio_out` climbed normally — the model spoke, the user never heard it, so nobody ever replied. **Lesson worth keeping:** a fail-soft table with no health check is undetectable — `ok:false` in a payload nobody alerts on is not detection. Documented in `DATABASE_SCHEMA.md`. | VTID-03480 |
| 2026-08-01 | **Decided (not yet built) the concrete AI/voice provider replacements for the GCP full-cutover draft spec**, at explicit user request. `docs/vtids/VTID-PENDING-GCP-FULL-CUTOVER-SPEC.md` preconditions 3–5b updated: ORB voice → Amazon Nova Sonic (promoted out of canary, replacing Vertex Live entirely, no GCP fallback retained); TTS → Amazon Polly (replacing Google Cloud TTS across all 4 call sites); non-voice text AI → Claude via the existing Bedrock adapter. Two gaps surfaced while confirming these are actually buildable: (1) `cover-image-outpaint.ts` calls Vertex **Imagen** for image *generation*, which Claude cannot do at all — decided to build a separate Bedrock Titan Image Generator adapter for this one feature, with the code's existing letterbox-blur fallback as the safety net if output quality doesn't hold up; (2) at least one feature (`anthropic-vision-client.ts`'s Shorts auto-metadata) needs vision + forced tool-calling, which the Bedrock adapter doesn't support yet (CLAUDE.md §2b) — decided to extend the adapter rather than carve out a permanent exception. This removes the "or accept a written exception" branch the draft spec previously had for AI/voice providers — decided 2026-08-01, so the only open question is now build sequencing, not the target. Documentation only; no code changed yet. | (draft spec update, no VTID) |
| 2026-08-01 | **ORB voice: WebSocket is now the browser's default transport, and the WS session start stopped being a second implementation.** The widget's default flips from SSE-down + one authenticated POST per 64ms audio chunk (~15.6 req/s while the user speaks) to the single bidirectional socket at `/api/v1/orb/live/ws`. The blocker was not the flip — it was that the WS `start` frame ran a fork of session start dating to VTID-01222, which had never received wake-brief selection (VTID-03079/03101), journey guidance (VTID-03300), guided-topic narration (VTID-03290), fast-start wake deferral, the voice quota gate (VTID-03107), the `AUTH_TOKEN_INVALID` re-auth signal, or reconnect continuity (VTID-02020's `transcript_history`/`reconnect_stage`/`conversation_id`). Six features added to the HTTP path over ~7 months, silently absent from the WS one — flipping the default first would have regressed the opener for every logged-in session. New `orb/live/session/ws-start-adapter.ts` runs the WS start through the same `handleLiveSessionStart` the HTTP path uses (it touches only `req.identity`/`req.headers`/`req.get()`/`req.body`/`res.status().json()`), deleting ~290 lines of fork. **Consequence to know:** the live session id and the `ws-<uuid>` socket id are now different strings — `wsClientSessions` is keyed by the socket, `liveSessions` by the live id, and `cleanupWsSession` was leaking the live session by deleting under the wrong key. Safety on the flip: automatic one-shot fallback to SSE when a WS start fails for a *transport* reason (latched per tab in sessionStorage, not localStorage — a network that blocks upgrades is where the user is, not a verdict on their browser), server rejections deliberately NOT retried on SSE, and a new unauthenticated `GET /api/v1/orb/live/transport` backed by `FEATURE_ORB_WS_TRANSPORT_ENV` so the default can be revoked without redeploying a static asset. | VTID-03471 |
| 2026-07-31 | Fixed two live bugs in the Vitana text-chat DM bridge (`services/gateway/src/routes/chat.ts` → `processConversationTurn`), reported by a user messaging the Vitana bot: (1) asking Vitana to send a message to another member got an unrelated "improve your nutrition index" question glued onto the front of the reply — `buildAssistantMemoryContext()` (`memory-orchestrator.ts`) unconditionally injected the active Life Compass goal into every community-role text-chat turn regardless of relevance to what was actually asked; unlike ORB voice, text chat has no separate Life Compass block, so this was the only gate. Added a cheap EN+DE relevance classifier (`isGoalRelevant`, same style as the existing `detectSocialIntent`) so the goals section only renders on turns plausibly about goals/progress — goals are still loaded for telemetry either way. A pre-existing test (`memory-social-conversation-flow.test.ts`) had encoded the identical bug shape (goals unconditionally present alongside a pure person question) as expected behavior; updated to assert the corrected behavior. (2) The bot then sent a second, truncated near-duplicate of its own reply as a separate message — `handleVitanaTextReply()` is fire-and-forget with no idempotency key, and the frontend's re-entrancy guard (`MessageInput.tsx`, `isSending`) is React state, not synchronous, so a fast double-send before either side re-rendered could fire two independent, non-deterministic LLM turns that each wrote their own reply. Added a per-user in-flight guard in `chat.ts` (server-side, authoritative) and a synchronous ref lock in `MessageInput.tsx` (client-side, defense-in-depth; companion commit in `exafyltd/vitana-v1`). Full local suite: 605/605 suites, 11830/11843 tests passing (7 skipped, 6 todo — pre-existing). | VTID-03458, VTID-03459 |
| 2026-07-31 | **Drafted (not allocated) the execution-VTID spec for a full GCP-to-AWS operational cutover**, at explicit user request, following up on the same-day investigation above. `docs/vtids/VTID-PENDING-GCP-FULL-CUTOVER-SPEC.md` — uses the real canonical spec template (`specs/governance/canonical-spec-template-v1.md`, VTID-01191) and real governance rule IDs (GOV-AGENT-002/003/004, GOV-API-003). Explicitly framed per the user's stated intent: GCP stays running and re-activatable (not decommissioned) — this spec's non-goals exclude `docs/AWS-CUTOVER-RUNBOOK.md` §5's GCP-decommission phase entirely. Its 12 preconditions are the runbook's §2 checklist plus everything the same-day investigation found and this file doesn't yet track elsewhere: the reopened DMS item, the `oasis-projector` locking decision, ORB voice's two GCP dependencies (Vertex Live ADC + Cloud TTS), the non-voice Vertex-default decision, no AWS equivalent for Cloud Scheduler, `openclaw-bridge`'s missing AWS pipeline, and reconciling `exafyltd/vitana-infra`'s stale `phase8-data-prod` state. No VTID number was allocated — per `CLAUDE.md` §4.1's own exception for this specific kind of VTID, allocation is left for whoever has the sign-off conversation the runbook requires, not self-allocated on the usual "always allocate immediately" rule. Cross-linked from `docs/AWS-CUTOVER-RUNBOOK.md` §0. | (draft spec, no VTID) |
| 2026-07-31 | Codified self-service VTID allocation as standing governance (Part 1 rule 2b, §4.1): Claude allocates a VTID itself via `POST /api/v1/vtid/allocate` (or the `allocate_global_vtid` Supabase RPC directly) at the start of every new task, sets `spec_status='approved'`/`status='in_progress'` when the user has directly instructed the work, and never asks the user whether/for a VTID again. One VTID per distinct piece of work. | VTID-03448 |
| 2026-07-31 | Fixed ORB Navigator "options within options" loop reported on Nova Sonic: `tool_navigate()`'s legacy `confirmation_needed` branch (`services/gateway/src/services/orb-tools-shared.ts`) told the model to call `navigate()` again with free text after a clarifying question, re-running full disambiguation from scratch and occasionally landing on a *different*, deeper ambiguous match — the mechanism behind "pick an option → get suboptions → get sub-suboptions." Aligned it with the existing VTID-02781 contract (ask once, then `navigate_to_screen(screen_id)` directly, never a second `navigate()` call), extended `NAV_CONTINUATION_BIND` pending_cta binding to this branch, added a same-turn re-entry guard in `handleNavigate`/`handleNavigateToScreen` (`orb-live.ts`) so a model that chains a second navigation tool call mid-turn (observed live on Nova Sonic — see VTID-03447's sibling comment) gets a short-circuit instead of a fresh consult, and clarified the `navigate` tool's own description (`live-tool-catalog.ts`) to distinguish "confirming an already-resolved either/or" (→ `navigate_to_screen`) from "confirming a destination offered from general knowledge with no screen_id yet" (→ `navigate` with the offered text) — the two cases the tool description previously conflated. | VTID-03446 |
| 2026-07-31 | Fixed ORB greeting users by their Vitana ID handle (e.g. "Dragan3") instead of their first name, reported on Nova Sonic. `buildLiveSystemInstruction()` (`services/gateway/src/orb/live/instruction/live-system-instruction.ts`), shared by the Vertex AND Nova Sonic raw-WS transports, pins a loud, structural `=== AUTHORITATIVE USER VITANA ID ===` header near the top of the prompt but never gave the user's real name equivalent prominence — it only ever appeared buried inside memory-fact bullet lists deep in `bootstrapContext`. Gemini reliably infers "use the name fact for address" anyway; Nova Sonic does not, and falls back to the one loud, explicit identifier available — the handle. `orb-livekit.ts` already solved this exact failure mode under VTID-03014 (its own comment describes the identical symptom: "Hi @e2etest33!" instead of "Hi Dragan!"), but that fix was never ported to the shared WS path. Added a parallel `=== AUTHORITATIVE USER NAME ===` header, wired from `session.greetingFirstName` (already resolved via `resolveSpokenFirstName()` in `live-session-controller.ts` for the spoken-opener path, but never previously threaded into the system instruction itself). | VTID-03447 |
| 2026-07-31 | **Full GCP-cutoff prep: investigated 3 open items from the readiness checklist, found the missing `exafyltd/vitana-infra` repo.** Documentation/investigation only — no infrastructure changed, no VTID authorizes a full cutover yet (none exists). Findings: (1) The `vitana-tg-gateway-prod`/`vitana-tg-community-prod` naming "mystery" is resolved — the owning Terraform lives in `exafyltd/vitana-infra` (TMC migration team's handover, not previously attached to this repo's sessions), whose own README already documents the naming drift as deliberate. (2) That discovery surfaced a bigger, more urgent risk: `vitana-infra`'s README says **"DO NOT terraform apply YET"** — its checked-in state is stale vs. live infra (would revert ECS↔ALB attachments, the gateway health check, and live task-def secrets if applied), and `phase8-data-prod` (Aurora prod) has never been reconciled against live state at all. Added as a new blocker to §1b's hard rules and the cutover runbook §1. (3) The ~22 "unexplained" ECS services are mostly identified — `vitana-infra/terraform/phase4-ecs/variables.tf` defines all 28 intended services from the TMC handover plan; cross-checked against this repo's `services/` tree, 6 have real source (marked non-deployable/in-process here, worth confirming AWS doesn't run them standalone instead) and ~14 have no corresponding source anywhere (likely TMC-internal tooling). (4) The Aurora DMS ~154k row-drop finding from VTID-03419 (2026-07-27) was never reflected back into the runbook's §2 checklist, which still showed "DMS replication healthy [x]" from an earlier, unrelated one-row fix — reopened that checklist item; it remains unresolved and requires live DMS access this session didn't have (`aws sts get-caller-identity` failed with `InvalidClientTokenId` on the AWS credentials present). Updated `docs/AWS-CUTOVER-RUNBOOK.md` §1/§2 and this file's §1b accordingly. | (investigation, no VTID) |
| 2026-07-31 | **Config drift from the VTID-03419 cutover took ORB voice down for every logged-in user — no code change involved.** `FEATURE_ORB_FAST_START_ENV` was never carried onto the `vitana-gateway-awsdr` task def, so `shouldDeferWakeWork()` fell back to the legacy inline path and the ORB wake-brief/journey assembly ran ON the `session/start` response. Measured on the *same commit* (`cb66c144`): AWS prod 5.19s / `context_status:ready` vs GCP prod (still-running rollback target) 2.08s / `context_status:pending`. Identity→session.start p50 went 0.17s (≤07-26) → 3.2s (07-28+), p95 past 9s, starting 07-27 — the cutover date. Cold authenticated starts then exceeded the orb widget's **8s** fetch abort, and the widget's `_sessionStart` catch set the error aura but never updated the status text or retried, so the overlay showed "Verbinden..." forever; anonymous sessions were unaffected (they skip wake-brief), which is why logged-out ORB looked healthy. **Beware the shape of this bug:** `isFeatureLive` maps `'staging-only'` → `isStaging`, so copying staging's value verbatim still leaves a flag DEAD in prod — "the var is set" does not mean "the feature is on". Fixes: `AWS-PROD-DEPLOY-GATEWAY.yml` now pins `FEATURE_ORB_FAST_START_ENV=staging+prod` unconditionally on every prod deploy; the widget's failed-start path now states the real failure and hands off to `_attemptReconnect()`; new admin-gated `GET /api/v1/admin/feature-flags` reports each flag's **resolved** `live` value (plus `env_var_present` and a `misconfigured_for_env` marker for the staging-only-in-prod trap) so two stacks can be diffed instead of guessed. Only ORB_FAST_START had measured evidence and was changed — the other 8 flags are reported, not flipped. | BOOTSTRAP-ORB-FASTSTART-DRIFT |
| 2026-07-29 | **Governance correction, not new work:** `docs/AWS-CUTOVER-RUNBOOK.md` §1's DNS row still said "Unmoved" and §3's "EXECUTION RECORD" citation pointed at content that was never actually written, and this file's §1b/Never-rule-1 prose still said "not yet a sole-production cutover" with no VTID-03419 changelog row at all — despite VTID-03419 (below) having genuinely executed 2 days earlier. The infrastructure change was real and independently verifiable (DNS resolution, live production traffic, working PUBLISH deploys against it); the paper trail describing it was not committed. Root cause: the doc-update step in VTID-03419's own spec (§5) was apparently never pushed before that session's context was summarized. Found via a second Claude session's independent skepticism of a status claim — see its investigation for the discovery. Fixed: runbook §1/§3 now match reality (with real EXECUTION RECORD blocks — ALB rule priorities, exact DNS record changes, the Cloudflare Worker origin override that actually gated the apex leg, verification method, rollback path), this file's §1b/Never-rule-1 updated, VTID-03419 changelog row added below. | (governance fix, no VTID) |
| 2026-07-27 | **GCP → AWS production cutover for gateway + frontend (VTID-03419).** Repointed `gateway.vitanaland.com` (A→CNAME, `34.111.235.0` → `vitana-alb-prod`) and the `vitanaland.com` apex/`www` (CNAME → the same ALB) to AWS — these two hostnames are now **sole production on AWS**, not DR. Deliberately narrow: excluded Aurora-dependent services (DMS showed ~154k silently-dropped row applies — Aurora is not a valid failover target), `oasis-projector` (dual-writer risk against a DMS-managed table), `orb-agent`/ORB voice (hard Google-Cloud-service dependency, unrelated to hosting), and any GCP decommission — GCP stays fully running as the standing rollback target. Pre-flight added ALB host-header rules at priority 3/4 (below the pre-existing path rules at priority 10, which would otherwise route to AWS staging regardless of `Host`). Caught and fixed a live blocker mid-cutover: a Cloudflare Worker (`vitanaland-proxy`, dashboard-managed) had route rules on `vitanaland.com/*` that override DNS entirely with a hard-coded GCP origin — DNS alone did not move apex traffic; the Worker's origin had to be patched too. Verified via authenticated read+write, a forced-HTTP/1.1 WebSocket handshake, and external-vantage fingerprinting (both clouds report `env:"production"`, so status fields alone don't distinguish them) — 60-minute post-cutover alarm watch clean. Full execution record: `docs/AWS-CUTOVER-RUNBOOK.md` §3. | VTID-03419 |
| 2026-07-28 | AWS staging→prod publish path (PUBLISH parity): `AWS-PROD-DEPLOY-GATEWAY.yml` gained `deploy_mode=promote-staging` (new default — ships the EXACT ECR image `vitana-gateway` staging runs, verified over HTTP build-info, pinned via new `expected_commit` input; `rebuild-main` keeps the old from-source path) and its smoke URL default is now canonical `gateway.vitanaland.com`. Gateway: new `PUBLISH_TARGET_CLOUD=aws\|gcp` switch (default `gcp`, zero change until set) makes `POST /operator/publish` promote AWS staging→AWS prod (frontend leg → `AWS-PROD-DEPLOY-FRONTEND.yml`; optional `GCP_DUAL_PUBLISH_ENABLED` refreshes the GCP rollback target; canary → 400 on AWS) and backs `/operator/revisions` for the gateway rows with build-info from the AWS stacks — fixes the Command Hub PUBLISH popover's "Could not load: staging 500" on the ECS-served gateway (no GCP ADC there). New `services/gateway/src/services/aws-gateway-admin.ts` (HTTP-only introspection; `vitana-ecs-task-role` has no `ecs:Describe*`). | VTID-03420 |
| 2026-07-24 | Added automatic once-a-day "Did You Know" News Feed card: `did_you_know_state` table (per-tenant rotation index) + `POST /api/v1/scheduled-notifications/daily-feature-tip` (advances through a curated `services/gateway/src/data/feature-tips.ts` list, publishes a tenant-wide `did-you-know-feature` announcement, fans out in-app + push in each user's locale) + Cloud Scheduler entry (`scripts/setup-cloud-scheduler.sh`, daily 17:00 UTC). Companion vitana-v1 fix: feature-announcement cards no longer pinned permanently at the News Feed top — now merge chronologically into the post stream so they get pushed down by new posts, per live user report. No VTID existed for this yet; tracked under this BOOTSTRAP tag pending one. Requires someone with `gcloud` access to run the updated `setup-cloud-scheduler.sh` once to actually create the Cloud Scheduler job — code shipping does not create it automatically. | BOOTSTRAP-DAILY-FEATURE-TIP |
| 2026-07-24 | Built the AWS-DR RunTask dispatch path for the autopilot executor — new `dispatchExecutorJobAws()` in `services/gateway/src/services/aws-ecs-admin.ts` (mirrors `dispatchExecutorJob()`'s return shape via `ecs:RunTask` against task def family `vitana-autopilot-executor`), branched in `dev-autopilot-execute.ts` on a new `DEV_AUTOPILOT_JOB_CLOUD=aws\|gcp` env var (default `gcp`). New `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` (build+push+register only — no ECS service to roll, next RunTask dispatch picks up `:LATEST`). `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` deliberately omitted from the live task definition (deferred pending AWS/Anthropic sponsorship decision). Updated §1b table + Never-rule exception. | VTID-03415 |
| 2026-07-24 | Added the missing AWS deploy pipeline for `orb-agent` (`AWS-PROD-DEPLOY-ORB-AGENT.yml`) — the ECS service and task def family (`vitana-orb-agent`) already existed from the unexplained 2026-07-09 bulk-provisioning event, but had no CI/CD, so it could silently drift from `main`. No public ALB/DNS (outbound-only to LiveKit Cloud) — verified via ECS-level container `healthCheck` + `aws ecs wait services-stable`. Updated §1b table. | VTID-03414 |
| 2026-07-23 | Added `docs/AWS-CUTOVER-RUNBOOK.md` — the previously-missing GCP→AWS full production cutover runbook: go/no-go checklist, DNS repoint sequence, rollback/TTL plan, GCP decommission checklist (later phase), and the two open decisions (frontend gateway-URL strategy, orb-agent/autopilot-job AWS parity) that need explicit user sign-off. Documentation/governance only — does not authorize or execute any cutover; a separate execution VTID gated on this runbook's checklist is still required. Added §1b pointer. | VTID-03412 |
| 2026-07-23 | Hardened the 3 already-fixed AWS-DR backend services (`oasis-projector`, `worker-runner`, `verification-engine`) toward gateway-grade rigor: ECS-level container `healthCheck` on all 3 task definitions (ECS Fargate does not honor a Docker image's own `HEALTHCHECK`), 3 new `AWS-PROD-DEPLOY-*.yml` dispatch-only workflows, 9 CloudWatch alarms, Container Insights enabled cluster-wide. Deliberately **no** autoscaling (oasis-projector's Ledger Writer has no cross-instance locking) and **no** public ALB/DNS (none of the three have external callers). | VTID-03411 |
| 2026-07-23 | Rebuilt `oasis-operator` for AWS Production (DR) — its source didn't exist in git (an abandoned `main.py.backup-*` stub was the only trace); restored `main.py` from the last known-good snapshot, added `requirements.txt` + `Dockerfile`, and extended its CORS allowlist to the current Vitana gateway hosts. New ECS service `vitana-oasis-operator-awsdr`, target group `vitana-tg-oasis-op-awsdr`, ALB host rule `dr-oasis-operator.vitanaland.com` (priority 7), first-ever CI/CD path `AWS-PROD-DEPLOY-OASIS-OPERATOR.yml`. | VTID-03410 |
| 2026-07-23 | Built AWS Production (DR) for `community-app` (frontend) — new ECS service `vitana-community-app-awsdr`, target group `vitana-tg-community-awsdr`, ALB host rule `dr-app.vitanaland.com` (priority 6), new dispatch-only `AWS-PROD-DEPLOY-FRONTEND.yml` in `exafyltd/vitana-v1`. Static SPA build bakes the canonical **GCP prod** gateway URL into `.env.production` at build time — no runtime env var to flip post-build. Still on static AWS access-key repo secrets (OIDC is a follow-up). | VTID-03409 |
| 2026-07-23 | Added `feature_announcements` table + `/api/v1/admin/feature-announcements` (admin-only, publishes an announcement row read by vitana-v1's News Feed `FeatureAnnouncementCard` and fans out an in-app + push `feature_announcement` notification to every tenant member, locale-grouped via `bulkGetUserLocales` + the gateway i18n catalog per §13b). No VTID existed for this yet; tracked under this BOOTSTRAP tag pending one. Publishing to production is still gated behind the staging-first cutover (§15/§16) — this only ships the mechanism. | BOOTSTRAP-FEATURE-ANNOUNCEMENTS |
| 2026-07-23 | Stood up AWS Production (DR) for the gateway service — parallel to canonical GCP prod, not a migration: ECS service `vitana-gateway-awsdr`, dedicated target group + host-header ALB rule (`dr-gateway.vitanaland.com`), autoscaling + CloudWatch alarms, `AWS-PROD-DEPLOY-GATEWAY.yml` (dispatch-only, required reason, never on push). Added §1b governance section + Never-rule exception. GitHub OIDC deploy-role wiring left for an operator with IAM admin rights (session's AWS IAM user has zero IAM write permissions) — see `docs/AWS-PRODUCTION-BUILD-LOG.md`. Extended the same day to community-app/oasis-operator (VTID-03409/03410) and hardened further (VTID-03411); see those rows above. | VTID-03398 |
| 2026-07-21 | Public "Business" tab: profile visitors can now see another user's active product recommendations (storefront card, buy-through with commission attributed to the profile owner via the existing VTID-02950 `?rec=`/`rec_id` flow). New public endpoint `GET /api/v1/discover/recommendations/:vitanaId` (`discover-recommendations-public.ts`), auth-required (any logged-in viewer, not owner-only), never returns click/conversion/commission fields. No formal VTID existed for this extension; tracked under this BOOTSTRAP tag pending one. | BOOTSTRAP-PUBLIC-BUSINESS-PROFILE |
| 2026-07-13 | Integrated lycorp-jp/sim-use device-testing layer: `e2e/mobile-sim/` driver + smoke flow (iOS Simulator / Android), `MOBILE-DEVICE-E2E.yml` macOS-runner workflow, vendored sim-use agent skill + `vitana-mobile-testing` glue skill, `docs/MOBILE_DEVICE_TESTING.md` | BOOTSTRAP-SIM-USE-DEVICE-TESTING |
| 2026-06-04 | Staging-first cutover (time-gated, effective Mon 8 Jun 2026 10:00 Europe/Berlin): added a `cutover_gate` job to every auto-to-prod workflow (`AUTO-DEPLOY`, `DEPLOY-ORB-AGENT`, `DEPLOY-AUTOPILOT-JOB`, `VTID-02409-BOOTSTRAP`) that freezes the push path post-cutover while leaving manual dispatch open; added manual escape hatch `scripts/deploy/publish-to-prod.sh`; rewrote §15/§16 + IF-THEN CI/CD rules. Before cutover all paths still reach prod; after, auto = staging, prod = PUBLISH button / manual exception. Frontend (`vitana-v1`) gated in parallel. | BOOTSTRAP-STAGING-FIRST-CUTOVER |
| 2026-04-14 | Replaced broad visual verification with targeted protocol: screenshot what you changed, interact with it, verify it works | VTID-01917 |
| 2026-03-19 | Added CI/CD deployment pipeline critical lessons (Auto Deploy ≠ actual deploy) | BOOTSTRAP-OPERATOR-NAV-FIX |
| 2026-02-13 | Added Deployment Verification Protocol section + rules | VTID-01228 |
| 2026-02-03 | Added Memory & Intelligence Architecture section | VTID-01225 |
| 2026-01-21 | Added ALWAYS/NEVER/IF-THEN core rules | VTID-01200 |
| 2026-01-21 | Initial creation with technical reference | VTID-01200 |

---

## Mandatory Codebase Intelligence Workflow

Before planning, modifying, debugging, reviewing, or generating code, always query both RepoWise and Graphify. Do not begin implementation from assumptions or broad grep searches.

### 1. Verify index freshness

1. Determine the current repository and Git `HEAD`.
2. Select the correct RepoWise MCP server. Never use an index belonging to another repository or an older checkout.
3. Confirm RepoWise's indexed commit matches `HEAD`.
4. Check for `graphify-out/graph.json`.
5. If either index is missing or stale, update it before implementation:
   - `repowise update`
   - `graphify --update`

Report any indexing failure clearly. Do not silently continue with stale information.

### 2. Read the codebase before execution

Use RepoWise for precise code and health information:

1. Call `get_overview` once to understand architecture, layers, entry points, and key modules.
2. Use `search_codebase` to locate relevant concepts, symbols, and paths.
3. Use `get_context` for compact file and module context.
4. Use `get_symbol` only when full implementation bodies are required.
5. Use `get_why` when architectural decisions or historical rationale matter.
6. Call `get_risk` before changing shared, central, or high-risk files.

Use Graphify for relationships and system-wide reasoning:

1. Run `graphify query "<task-specific question>" --budget 1500`.
2. Use `graphify path "<source>" "<target>"` to trace dependencies or data flow.
3. Use `graphify explain "<component>"` for unfamiliar systems.
4. Pay particular attention to god nodes, community boundaries, dependency paths, and surprising cross-module connections.

### 3. Produce a pre-execution code map

Before editing, establish:

- Relevant entry points and execution flow.
- Files, symbols, modules, and tests involved.
- Upstream and downstream dependencies.
- Existing patterns that should be followed.
- Architectural constraints and recorded decisions.
- Health hotspots, complexity, missing tests, and change risk.
- The smallest safe implementation scope.

Do not start execution until this map is sufficient to explain what will change, why, and what may be affected.

### 4. Minimize token and search waste

- Treat RepoWise and Graphify as the primary navigation layer.
- Do not recursively read directories or perform broad grep searches when an indexed query can answer the question.
- Retrieve compact context first and expand only the exact files or symbols required.
- Do not repeatedly call `get_overview` during the same task unless the index changes.
- Reuse already retrieved results instead of requesting identical context again.
- Raw file reads are allowed only for targeted implementation details, verification, or when an index result is missing, stale, ambiguous, or approximate.
- Source code and tests remain the final authority; never invent a relationship that the indexes or source do not support.

### 5. Validate after implementation

After changing code:

1. Run the relevant tests, linting, type checks, and build.
2. Re-query change risk for the affected files when appropriate.
3. Update both indexes:
   - `repowise update`
   - `graphify --update`
4. Confirm the indexes now match the final Git state.
5. Summarize changed behavior, affected dependencies, risks, and verification evidence.

A task is not complete until the implementation is verified and both indexes are current.

For Graphify's built-in Claude integration, also run once per repository:

```
graphify claude install
```

This workflow improves Claude's navigation speed, token efficiency, and change accuracy. It does not automatically improve application runtime performance—that requires acting on the health and performance findings uncovered by the indexes.
