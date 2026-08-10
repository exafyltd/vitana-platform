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

21. **Always check which database a service actually points at — do not
    assume.** Aurora (`vitana-aurora-prod`) is the INTENDED primary for
    staging and production (owner decision, 2026-08-10, VTID-03564). It is
    **not yet the live one**, and the gap is measured, not guessed:
    - Both `vitana-gateway-awsdr` (prod, rev 51) and `vitana-gateway`
      (staging, rev 173) carry **only** `SUPABASE_*` secrets. Neither has
      `AURORA_DATABASE_URL` or `DATABASE_URL`. Every runtime read and write
      goes to Supabase over PostgREST.
    - **DMS is dead.** `vitana-supabase-to-aurora` stopped 2026-07-21;
      `vitana-supabase-to-aurora-v3` is `FAILED` — `FATAL_ERROR` after 7
      recovery attempts, 2026-07-27. No CDC task runs, so Aurora has taken
      no updates since July and is a stale full-load snapshot.
    So: **writing to Aurora today does not reach users, and reading it
    returns July data.** The one exception is DB-content i18n, whose
    `DB_I18N_TARGET` now defaults to `aurora` (VTID-03564) — a seeder-only
    surface with no runtime caller, deliberately flipped first so nobody
    seeds Supabase by accident mid-migration. Everything else is Supabase
    until a task definition says otherwise. Verify with
    `aws ecs describe-task-definition`, never from intent.
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

31. **NEVER sign this account in against a production host** (`vitanaland.com`,
    `www`, `dr-app.vitanaland.com`, `gateway.vitanaland.com`). Point it at a PR
    preview or staging (`preview.vitanaland.com` / `preview-gateway.vitanaland.com`).
    Reading prod as the test user is fine; **writing** is not. (VTID-03506)
32. **IF** verifying a change needs content that does not exist yet (a post to
    like, a message to reply to, a video to comment on) → **THEN** create it on
    the preview/staging stack, never on prod. On 2026-08-05 five posts created
    by this account on production became **960 notifications and 600 pushes** to
    real members in ~6 minutes, because `trg_notify_community_post` fans out to
    the whole tenant. Deleting the posts did not recall the pushes. DB-level
    suppression now exists (`_notif_is_test_actor()` +
    `trg_suppress_test_actor_notifications`, vitana-v1 migration `20260805160000`)
    — it silences notifications, it does **not** keep test content out of the
    real feed, so it is not a licence to write to prod.

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

## 2d. IMAGE GENERATION — AMAZON TITAN (VTID-03497)

Build 3 of the 4 provider replacements gating a GCP shutdown, and the only
one Claude cannot cover at all: Vertex **Imagen** generates images and no
Anthropic model does, so this is a separate Bedrock adapter
(`services/gateway/src/providers/titan-image.ts`), not an llm-router provider.

Selected by **`IMAGE_PROVIDER=vertex|bedrock`, default `vertex`** — same
deliberate-opt-in shape as `TTS_PROVIDER` (§2c). **Deploying this changes
nothing.** Gated additionally on `BEDROCK_ROLE_ARN` (shared with §2b).

**There are TWO Imagen consumers, not one.** The cutover changelog previously
listed only the outpaint path; a Titan build covering just that would have
left AI cover generation silently broken on a GCP shutdown:

| Consumer | Imagen call | Titan taskType |
|---|---|---|
| `services/cover-image-outpaint.ts` | `EDIT_MODE_OUTPAINT` (capability model) | `OUTPAINTING` |
| `services/intent-cover-service.ts` | text-to-image (`imagen-3.0-fast-generate-001`) | `TEXT_IMAGE` |

### Three Titan constraints that are not cosmetic

1. **Titan accepts only a fixed set of width/height pairs — 1600x900 is not
   one of them.** `nearestTitanSize()` maps the cover canvas to **1280x720**
   (largest supported 16:9) and the outpaint path upscales the result back to
   1600x900. The mapping weights **aspect ratio above area** deliberately:
   satisfying a 16:9 request with 1024x1024 would letterbox or crop the
   subject — visually wrong, and invisible to a test that only asserts the
   call succeeded.
2. **Outpaint mask polarity is INVERTED vs Imagen, and is UNVERIFIED.**
   Imagen: white = generate, black = keep. Titan is documented the other way
   round, so `cover-image-outpaint.ts` negates its Imagen-convention mask
   before sending. Get this backwards and the **subject** is regenerated while
   the margins are preserved — a plausible-looking image that is completely
   wrong. Because no AWS credentials were available to confirm it, the polarity
   is env-overridable via **`TITAN_OUTPAINT_MASK_POLARITY=black-generates|white-generates`**
   (default `black-generates`). **If outpaint output looks wrong, flip this first.**
   The mask is resized with `kernel:'nearest'` so it stays strictly two-tone —
   a bilinear resize yields grey edge pixels and a non-deterministic seam.
3. **Titan is not offered in every region**, and the rest of Vitana's AWS
   estate is `eu-central-1`. `AWS_TITAN_IMAGE_REGION` is its own var
   (→ `AWS_BEDROCK_REGION` → `AWS_REGION` → `us-east-1`) rather than
   inheriting blindly; a wrong region fails with an opaque model-not-found.

### Also worth knowing

- Titan reports content-policy blocks in an `error` field **on a 200 response**
  — it does not throw. Treating that as success returns empty bytes; the
  adapter maps it to `error:'blocked'` → `unsafe_prompt`.
- **There is no server-side letterbox-blur fallback.** The cutover draft spec
  cited one as Titan's safety net; that behaviour is the *frontend's*, and
  `routes/cover-images.ts` simply returns an error when outpaint fails. Plan
  accordingly — a Titan quality regression surfaces as a failed request, not a
  degraded image.

### Before flipping `IMAGE_PROVIDER=bedrock`

Run `scripts/images/verify-titan-image.ts`. It checks model availability in
the configured region, the 16:9 size mapping, and — most importantly — renders
a deterministic red-subject probe that detects inverted mask polarity
automatically rather than leaving it to eyeballing. Needs `bedrock:InvokeModel`
on the Titan model for the gateway task role.

---

## 2e. ORB VOICE — NOVA SONIC GLOBAL PROMOTION (VTID-03501)

Build 4 of the 4 provider replacements gating a GCP shutdown. Adds a global
(non-canary) Nova activation path behind **`NOVA_SONIC_GLOBAL_ENABLED`,
default `false`**, requiring the exact string `'true'`.

`isNovaSonicIdentityAllowed()` short-circuits to true when it is set. The
allowlist semantics are deliberately **untouched** — "empty allowlist allows
NOBODY" still holds — so turning global off again restores exactly the prior
canary population with no allowlist edits.

Promotion widens **who** gets Nova, never **what** it runs on: the
`enabled`, language (`en/de/fr/es`) and `aws-ecs` runtime gates all still bite.

A promoted session reports `reason: 'nova_global_enabled'` and **`canary:
false`**, and `/api/v1/orb/nova-sonic/health` gained `global_enabled`. Without
those, every canary-scoped dashboard would keep reading "4 users" while Nova
served the entire user base.

### Promotion gate: CLEARED 2026-08-09 (VTID-03560) — was ⛔ DO NOT SET

**This section previously said "DO NOT SET `NOVA_SONIC_GLOBAL_ENABLED=true`
YET".** The one condition it was waiting on — a runtime fallback so a Nova
premature-close does not leave the user in silence — shipped as VTID-03502 and
went live on AWS prod at **2026-08-08 08:49 UTC**. Promotion was authorised in
conversation and executed under **VTID-03560**.

**What has NOT changed: the underlying Nova failure is still unroot-caused.**
Everything below about "Premature close" remains true. Promotion means ~10% of
sessions now take a reconnect hop through Vertex instead of failing silently —
it mitigates the symptom, it does not fix Nova. If you are here because voice
is misbehaving, read the whole section; and note the flag is reversible with a
single `AWS-PROD-DEPLOY-GATEWAY.yml` dispatch (`nova_sonic_global_enabled=false`),
which restores the exact prior canary population with no allowlist edits.

**Why it was promoted:** the Gemini API line is ORB voice — the Gemini Live
stream, billed per second of open connection — and was the largest remaining
GCP cost at $79.50 month-to-date vs. $3.75 for all text AI on Vertex. No
Anthropic model has a speech-to-speech API, so Claude cannot replace this path;
Nova Sonic is the only AWS route off it. Watch
`orb.upstream.nova.premature_close_fallback` for the post-promotion failure
rate — at canary scale it was 6 sessions in 7 days, and the whole point of
VTID-03501's `canary: false` reporting is that this stays measurable once the
population is everyone.

Nova currently fails **10.2% of sessions** (6 of 59, measured 2026-07-29 →
2026-08-05, spread evenly — a steady baseline, not a spike). All six carry the
identical diagnostic:

```
code: nova_stream_error
diagnostic: "Premature close"
```

The bidirectional HTTP/2 stream dies at open with `audio_in = 0`,
`audio_out = 0`, `turn_count = 0` and `greeting_sent = true`. **The user opens
ORB and gets silence with no indication anything failed** — the same invisible
class as the VTID-03480 `orb_session_state` bug. `audio_out = 0` is perfectly
correlated with this reason and appears under no other close reason.

Related signal: Nova's own `nova_validation` error reads *"Timed out waiting
for audio bytes or interactive content... gaps... less than 295 seconds"*, so
Nova enforces a hard inactivity deadline on the stream. Note the HTTP/1.1
workaround used for Bedrock (§2b) is **not available here** —
`InvokeModelWithBidirectionalStream` requires HTTP/2.

**Runtime fallback: SHIPPED (VTID-03502).** `novaClient.onClose` now routes
this case through `shouldFallbackToVertexOnNovaClose()` — an exported pure
predicate in `routes/orb-live.ts` — and on a match pins the session with
`_novaFallbackToVertex` and calls `attemptTransparentReconnect()`, the same
machinery `nova_rotation_exhausted_fallback` uses. The user lands on Vertex
instead of silence.

The discriminator is **`audioOutChunks === 0`**, plus: session active, close
not initiated locally, no rotation in flight, and not already fallen back.
`audio_out = 0` is the right signal because it is perfectly correlated with
`nova_stream_error` (6/6) and appears under **no other close reason** — a
mid-conversation drop always has audio out, so a healthy Nova session can
never be diverted by this. The already-fell-back guard stops a Vertex-side
failure bouncing back into the same branch and looping. Emits
`orb.upstream.nova.premature_close_fallback` and diag stage
`nova_premature_close_fallback`; if the Vertex reconnect ALSO fails, the
normal `connection_issue` frame is emitted rather than leaving the user with
nothing.

**This mitigates the 10% but does not fix it.** Nova still drops those
sessions; users now get a working Vertex session instead of silence. The
underlying "Premature close" cause is still unroot-caused and needs
CloudWatch-level investigation before Nova can be considered healthy enough
to promote.

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
5. **(VTID-03516) It is the autonomous plane's own work** — `metadata.source
   === 'self-healing'` or `metadata.autonomous_execution === true`.

**Criterion 5 is not optional bookkeeping — without it the other four
describe a Claude Code session's own VTID exactly.** §4.1 tells every session
to write `status='in_progress'` + `spec_status='approved'` onto the VTID it is
about to work itself. For six days the worker-runner read that as an
invitation, claimed those VTIDs ~20-30s after allocation, failed instantly on
a missing `ANTHROPIC_API_KEY`, and terminalized them `rejected`/`failed`. See
the 2026-08-06 VTID-03516 changelog row.

### Two execution planes, one ledger (VTID-03516)

There are **two** ways work gets done here and they share `vtid_ledger`:

| Plane | Who executes | Marks its rows with |
|---|---|---|
| **Session** | a Claude Code session / a human, in-conversation | anything else (`metadata.source` is free text — `claude-code`, `orb-voice`, `aws-sns-gchat-alerts`, …) |
| **Autonomous** | worker-runner → worker-{backend,memory,ai,…} | `metadata.source='self-healing'` or `metadata.autonomous_execution=true` |

- **Never** widen the autonomous claim pool with a denylist of session-looking
  `metadata.source` values. `source` is free text and most session VTIDs carry
  no `claude` marker at all — a denylist catches three strings and keeps
  sweeping everything else. The gate is an **allowlist**
  (`isAutonomousExecutionTask()`, `routes/worker-orchestrator.ts`), enforced on
  both the pending feed and the claim write path.
- **New autonomous producers must set `metadata.autonomous_execution = true`.**
  Being `in_progress` + `approved` is no longer sufficient and never should
  have been.
- **Never "fix" this by populating `ANTHROPIC_API_KEY` on the worker-runner.**
  The missing key is the only reason the collision was survivable — it made
  every misfire fail in one second. With a working key the worker-runner would
  instead have begun autonomously editing code for a VTID a session was
  concurrently working: silent concurrent writes, against this file's own
  "Never run parallel VTID executions". The eligibility predicate was the bug;
  the credential was the smoke alarm.

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

## 13c. VITANALAND COMMERCE — LONG-TERM VISION (self-service merchant onboarding)

**This is a standing product-direction framework, not a specific technical
spec.** Record it here because Discover/Commerce work will keep recurring
across sessions and VTIDs, and every future round should be evaluated
against this end goal, not just against the immediate ticket.

**The ultimate goal:** any business — one that already exists today, or one
that launches in the future — should be able to connect itself to Vitana's
Discover marketplace the same way DoctorBox, Awin (MISSHA), Amazon.ae, and
Admitad (AliExpress/Bodylab24) were connected, but **without needing a
human to hand-write a SQL migration for it.** Today's onboarding path
(confirmed via every merchant integration to date) is manual: a person
gathers catalog data, negotiates/accepts an affiliate relationship, and an
engineer seeds `merchants`/`products` rows by hand. That is the *current*
mechanism, not the *target* one.

**The target:** a self-service space/platform where a business owner can
plug their own storefront into Discover directly — modeled on how Shopify
itself works and feels for merchants (low-friction onboarding, an
app-store-like connection flow, clear ongoing control over their own
catalog/pricing/availability) — rather than requiring bespoke engineering
per merchant. This should eventually cover:

- **Existing businesses** with their own storefront/catalog wanting
  distribution through Vitana's audience.
- **Future/new businesses** that don't have an existing sales channel yet
  and want to launch and promote through Vitana as one of their channels.

**Why this matters for near-term decisions:** when doing incremental
Discover/Commerce work (a new merchant seed, a new sync provider, a new
attribution mechanism, a new commission flow), prefer designs that move
toward self-service plug-in-ability over designs that only solve the
one-merchant-in-front-of-us problem — e.g. prefer schema/config choices a
future onboarding UI could drive, over ones only an engineer running a
migration could drive. This doesn't mean over-engineering every single
merchant integration now; it means noticing when a shortcut is quietly
adding to the pile of hand-seeded, engineer-only onboarding debt, and
flagging that tradeoff explicitly rather than silently repeating it.

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
| 2026-08-09 | **ORB voice promoted off Google onto AWS Nova Sonic, and the two levers that move that bill were not settable until now.** Prompted by "turn off the Gemini API, we have Anthropic and should only use that" against a billing report showing Gemini API $79.50 MTD. **The premise needed correcting before acting on it, and the correction is the reusable part: the Gemini API line is not text AI — it is ORB voice, the Gemini Live stream billed per second of open connection.** All text AI is **$3.75** on the *Vertex* line, so routing text to Claude does not touch this bill at all, and no Anthropic model has a speech-to-speech API to replace the voice path with. Nova Sonic is the only AWS route off it. **First, the measurement that showed VTID-03510 had already worked:** prod picked up the idle reaper at 08-08 08:49 UTC, and ORB Live billed minutes went **427/day (08-07) → 99.9 (08-08) → 88.4 (08-09)**, avg session 21.4 min → 3.7 min, with the 32-minute `expired_ttl` bucket (97.5% of the old bill) at **zero sessions**. The report still showed $79.50 because it is *month-to-date cumulative* over 8 days, ~6.5 of them at the old rate — a running total cannot go down, which is worth remembering before concluding a cost fix did not land. **What was actually missing:** `AWS-PROD-DEPLOY-GATEWAY.yml` could set `NOVA_SONIC_ENABLED` but had no input for `NOVA_SONIC_GLOBAL_ENABLED` or `ORB_IDLE_NO_ENGAGEMENT_MS` — so the promotion was unreachable except by hand-editing the live task definition, **which is exactly the mechanism that had just cost four days of staging downtime under VTID-03513** (task-def wiring existing only in AWS state, invisible to review, cloned forward through every later deploy). Both are now EMPTY-preserving dispatch inputs in a diffable file; jq upserts verified idempotent against a mock task def. Nova global is a **separate branch** from the canary block on purpose — promoting to everyone and editing the allowlist are different decisions, and coupling them would mean you cannot do one without restating the other. **§2e's standing ⛔ DO-NOT-SET gate is cleared, not deleted:** its one condition was a runtime fallback so a Nova premature-close does not leave the user in silence, and VTID-03502 shipped that to prod 08-08 08:49. Every word of the "Premature close" diagnosis is deliberately retained — **the root cause is still unknown**, so promotion routes ~10% of sessions through a Vertex reconnect hop: mitigation, not a fix. Deployed `rebuild-main` (not `promote-staging` — that reads staging build-info and AWS staging is still 504ing) and **verified live rather than trusting the green check**: prod on `e3b87e9`, `/nova-sonic/health` reports `global_enabled:true`, `ready:true`, and `canary_user_count:4` **unchanged** so `nova_sonic_global_enabled=false` restores the exact prior population with no allowlist edits. The 90s idle budget could not be confirmed at deploy time — zero sessions in the following minutes at 22:17 UTC — and needs `idle_ms ≈ 90s` on the next real traffic. Watch `orb.upstream.nova.premature_close_fallback`: at canary scale the failure was 6 sessions in 7 days, and VTID-03501's `canary:false` reporting exists precisely so that rate stays measurable now the population is everyone. | VTID-03560 |
| 2026-08-09 | **`WATCHER_REMINDERS_ENABLED` was a kill switch for two of its three consumers — production read "off" while injecting.** `GET /api/v1/watcher/remind` reported `enabled_resolved` and then served the reminders regardless. The planner and executor are in-process and check `remindersEnabled()` themselves, so they were genuinely dark; **`worker-runner` is a separate service whose only path to the Watcher is that HTTP route**, and it never checked the flag. Measured on prod with the var unset: `enabled_resolved: false` and **six reminders in the same response**. A partially-effective kill switch is worse than none, because it makes you trust a state that is not real — and the state it misreported was "is this feature touching production prompts". The stale comment on the route asserted *"the worker-runner bridge uses buildReminders() directly and never traverses this route"*, which was simply false and is how the gap survived review; believing a comment over the call graph is the same failure mode as VTID-03531's unwired distiller. Gate now keys on **`record_shown`**, which already encoded caller intent: `record_shown=true` means "I am injecting this" and honours the flag; omitting it means "show me what the Watcher knows" and is always served, because an operator needs the preview to decide whether to flip the flag at all. Suppression happens **before** `buildReminders()` (tests assert `watcher_rules`/`watcher_lessons` are never queried, not merely that the array is empty, so a later refactor that builds-then-filters fails), returns **200 not an error** (worker-runner maps any non-2xx to null, which would make a deliberate off indistinguishable from a Watcher outage), and reports a new `injection_suppressed` so "off, so you got nothing" is distinguishable from "on, and there was nothing to say". 4 new route tests; suite 628/628, 12,228 passing. | VTID-03551 |
| 2026-08-08 | **The Watcher stored memory none of its own consumers could read — the same defect as the row below, one layer up.** After VTID-03531's backfill: **34 lessons stored, 25 injectable by frequency, 0 returned to any real caller.** `distiller.ts` copied `evidence.service` into the lesson's retrieval `scope`. But `scope` is a retrieval FILTER — `scopeMatches()` deliberately refuses a scoped lesson whenever the caller omits that key (correct; otherwise a scanner-specific lesson leaks into every unrelated prompt) — while `evidence.service` is the name of the service that **emitted** the event. Provenance, not caller context. Conflating them made every lesson unreachable by all three consumers at once: `dev-autopilot-planning` and `dev-autopilot-execute` pass `stage`+`scanner` and never a service, and `worker-runner` passes its **domain** (`'backend'`) against an **emitter name** (`'worker-backend'`) — even the one caller that supplied the key could never match. Proven live rather than inferred: `/remind?stage=execute` → 3 rules + **0** lessons; the same call with `&service=autopilot-controller` → 3 rules + **3** lessons. Nothing was wrong with the lessons, the scoring, the quarantine or the endpoint — only the scope key. Second defect found in review (#3062) and worse than the first: `upsertLesson`'s recurrence branch updated frequency, evidence and text but **never `scope`**, so any pattern already in the table kept the scope it was born with **permanently**, no matter how often the definition changed afterwards — a scope fix would have applied only to patterns never seen before, leaving all 34 backfilled rows (the highest-frequency ones, i.e. most of the value) dead for good. Recurrence now writes scope, so a definition change **self-heals** instead of needing an out-of-band migration; the 36 existing rows were cleared with `scope = scope - 'service'` so they became reachable immediately. Verified on the exact contexts the real callers use — both previously zero — now **6 reminders, 3 of them learned** (`seen 113x`, `43x`, `41x`). **Standing lesson: VTID-03531 and this are one defect at two layers — one stored memory nothing wrote to, the other wrote memory nothing could read. Both passed every unit test, because each component was individually correct. The failure was in the SEAM, and seams are what unit tests are worst at. Verifying "the feature works" has to mean asking a real consumer for a real answer, not confirming each part is green.** | VTID-03534 |
| 2026-08-08 | **The Watcher was recording history it could never turn into memory — 591 lifecycle steps over 3 days, including many failures, against a `watcher_lessons` table holding exactly 0 rows.** Two independent silent bugs, both fully covered by *passing* tests. (1) **The distiller had no call site.** Phase 2 (VTID-03461) shipped `distilBatch()` and `upsertLesson()` fully unit-tested and nothing ever invoked either — zero callers outside tests. A unit test of a pure function cannot notice that no caller exists, so the suite stayed green while the learned half of the system did nothing at all. `observerTick()` now distils the rows each tick actually INSERTED (not those the overlap rescan skipped — already distilled when first seen, so distillation is idempotent across the rescan with no second dedupe pass), after both scans rather than between them so one tick's repeats count as ONE recurrence. (2) **`upsertLesson()` never incremented `frequency`** — a plain PostgREST upsert cannot express `frequency = frequency + 1`, so every lesson sat at 1 forever while `last_seen_at` refreshed on each recurrence, and `loadLessons()` withholds frequency-1 lessons until they age past `SINGLETON_QUARANTINE_DAYS`. **The more often a pattern recurred, the more reliably its quarantine clock got reset** — a recurring failure, the only kind worth remembering, was the one thing guaranteed never to be injected. Fixing (1) alone would have filled the table with lessons that could never be served. Now a read-then-write that matures the row, merges `evidence_step_ids` (bounded at 20), recomputes confidence, and treats a `23505` race as success. Also: `GET /api/v1/watcher/health` now reports lesson totals beside cursor state ("the observer is healthy" and "the Watcher is learning" are independent facts and for 3 days they diverged completely — cursor health alone could never show it); `WATCHER_REMINDERS_ENABLED=true` added to `STAGE-DEPLOY.yml` **staging only** and deliberately NOT to `AWS-PROD-DEPLOY-GATEWAY.yml`, whose flag block is reserved by its own comment for flags with measured prod evidence — this is a feature activation, not an outage fix, so it graduates via PUBLISH. Companion `exafyltd/vitana-v1` commit adds the `SessionStart`/`Stop` hooks and a **deliberate copy** of `scripts/watcher/session-hook.sh` (duplicated, not cross-referenced: a session hook must work when only one repo is checked out, and a path into the platform repo would make frontend sessions silently stop recording — the exact failure this subsystem exists to catch). **Standing lesson: a green unit-test suite proves a function works, not that anything calls it. Coverage of the call graph is a different thing from coverage of the functions in it.** Gateway suite 613/613 suites, 12,031 tests passing; `tsc` clean; 8 new tests, 6 of which assert the WIRING and fail if the distiller is ever unwired again. Note `dev_autopilot_executions` still writes 0 steps and that is NOT a fault — that table's newest row is 2026-07-13; the autopilot has not run in three weeks. Session ingest remains closed (`503`, 0 rows) until an operator sets `WATCHER_SESSION_TOKEN`. | VTID-03531 |
| 2026-08-07 | **The curriculum and Navigator catalog now tell CI when they change — the half of "no language left behind" that git cannot see.** `src/i18n/**` propagation rides push events; these two surfaces are edited in the admin UI and published straight to the database, so no push ever fires. `I18N-DB-SEED.yml` already subscribed to `repository_dispatch: db-i18n-source-changed` and **nothing posted it**, leaving the nightly cron as the only automatic mechanism — "edit one session → every language follows" was true but next-morning. New `triggerRepositoryDispatch()` sits beside the existing `triggerWorkflow()`, reusing its token and headers; `repository_dispatch` rather than `workflow_dispatch` **on purpose**, because it addresses an EVENT rather than a file, so a third surface added later subscribes without editing the gateway. Hooked into `publishChecklist()`, `rollbackChecklist()` — **a rollback counts**: the German text users see reverts to an older snapshot, leaving every stored translation derived from text that is no longer current — and `invalidateNavCatalogCache()` rather than the four `nav_catalog` admin handlers. Those four already call it; hooking the handlers would mean a fifth write path had to remember two things instead of one, and **the one it forgot would fail silently, because a locale that never updates looks exactly like a locale with nothing to update**. Three properties in priority order: (1) it can never fail the operation that triggered it — the admin's publish is the intent, notifying CI is a side effect, and a GitHub outage must not turn a committed publish into an error response; (2) a failure is still visible — `DB_I18N_DISPATCH_FAILED` names the *consequence* ("will not update until the nightly cron"), not just the error, so the guarantee degrades to next-morning and never to silence; (3) bursts coalesce into one dispatch per 30s window, so an admin editing twenty Navigator entries is one workflow run rather than twenty. On by default with `DB_I18N_AUTO_PROPAGATE=off` as the kill switch — an opt-IN flag would have reintroduced the manual step this removes — and an unrecognised value stays ENABLED rather than failing closed, since a typo'd flag must not silently stop every language updating. 11 tests; the failure-isolation and coalescing guards were mutation-verified (removing either fails 2 tests). | VTID-03522 |
| 2026-08-07 | **`VALIDATOR-CHECK.yml` had been unparseable since #2995, so its CSP governance gate never ran on any PR — and the failure looked like flakiness.** The CSP step embeds a python heredoc whose body sat at column 0 in the file; a line less indented than the enclosing `run: \|` block scalar terminates it, so YAML then tried to parse `import re,sys` as a mapping key. GitHub recorded a **startup_failure — a run with zero jobs — on every ref**, and because the `name:` key was never parsed the run is listed by its FILE PATH rather than its workflow name, which is the tell that distinguishes this from an ordinary red check. Re-indented the heredoc body and terminator to the block scalar's base indentation, matching the already-correct step 40 lines above it; YAML strips that common indent, so the shell still receives both at column 0 and the semantics are unchanged. Verified two ways: `yaml.safe_load` over all 94 workflow files goes 1 failure → 0, and the extracted step still gates correctly — a file containing `eval(` is REJECTED with exit 50 while a clean file exits 0. **Worth remembering:** a workflow that fails to parse is not a workflow that fails; it silently stops enforcing whatever it was written to enforce, and no amount of reading the check name tells you that. | VTID-03521 |
| 2026-08-06 | **The gateway now opens a real PostgreSQL connection — its first ever — and the Aurora target for DB-content i18n is fully implemented.** `SUPABASE-TO-AURORA-MIGRATION-PLAN.md` §0 records why "point the app at Aurora" was never a config change: the gateway had **no Postgres driver in its dependency tree at all**, speaking HTTP to PostgREST, so there was no connection to repoint. `services/gateway/src/services/db-i18n/aurora-client.ts` + a real `AuroraDbI18nRepository` are that missing piece, scoped to the two DB-content i18n surfaces rather than the whole 2,480-call-site estate — that plan's own B1 sequencing (seam first, or the call sites get rewritten twice). **The design decision that matters: connectivity and write permission are SEPARATE flags.** `AURORA_DATABASE_URL` gates reaching Aurora; `AURORA_I18N_WRITES=enabled` gates writing to it, and defaults off even when Aurora is fully configured and reachable. Reaching a database is not permission to write to it — these two tables are **DMS replication targets from Supabase**, so a second writer is the "Option C" hazard that plan argues against and the reason `oasis-projector` was excluded from VTID-03419, and Phase 0 is still open (~154k silently-dropped applies, unreconciled). Collapsing the two flags into one would have made "I configured Aurora" silently mean "I authorised dual writes". **`--verify` is a concrete slice of the Phase 0 exit criteria**, not a debugging aid: that gate demands "full row-count + checksum reconciliation, Supabase vs Aurora, per table" and "a re-runnable reconciliation job, not a one-time manual check", and `source_sha` supplies the checksum for free — a row present on both sides but differing reports as a mismatch instead of counting as present. Both-NULL counts as agreement, since two unstamped legacy rows are equally unverifiable and flagging them would bury the real mismatches. Read-only, no write flag needed. **TLS, and the one deliberate hole:** `AURORA_CA_BUNDLE_PATH` verifies against the RDS CA bundle; with nothing set verification still runs against the system store and **fails** for RDS on purpose, because a specific certificate error tells an operator to install the bundle whereas a silent downgrade tells them nothing. `sslmode=disable` is honoured **for loopback hosts only** and throws for a remote host — a local Postgres has no TLS, and refusing it outright would leave an adapter whose entire substance is SQL untestable against a real server, i.e. untested; without the host check the same flag would be a one-line way to send production credentials across a network in the clear. **Testing is not mocked, and that is the point.** A mocked `pg` client confirms strings reached a fake; it cannot tell you the statement parses, that the `ON CONFLICT` target matches the primary key, or that multi-row `unnest` array binding lines the columns up — every mistake actually worth catching. 17 integration tests run the real SQL against a throwaway PostgreSQL 16 (upsert idempotency on the natural key, ON-CONFLICT-updates-not-ignores, column-for-column batch binding, the de-over-en source JOIN with its `source_lang` provenance, inactive-entry exclusion, JSONB snapshot extraction incl. malformed entries, and writes still blocked against a reachable DB without the flag). New `AURORA-I18N-INTEGRATION.yml` runs them on a `postgres:16` service container **with an explicit assertion that the suite did not skip** — the suite skips itself without `AURORA_TEST_DATABASE_URL`, and a skipped suite is green. 49 unit + 17 integration tests. **Not a migration, and not Aurora becoming primary** — `DB_I18N_TARGET` still defaults to `supabase`, and deploying this changes nothing. | VTID-03517 |
| 2026-08-06 | **The last manual step in adding a language was a DB CHECK constraint that made the new locales impossible, not merely untranslated.** Two tables hold user-visible text that never passes through `src/i18n/` and is therefore invisible to every frontend i18n check: `nav_catalog_i18n` (Navigator screen titles/descriptions — read by ORB voice intent matching) and `journey_checklist_translations` (My Journey curriculum). A locale can be at 100% catalog parity and still speak German on both. **The blocker:** `journey_checklist_translations.locale` carried `CHECK (locale IN ('en','es','sr'))`, so seeding `fr`/`pt`/`ru`/`pl` would have failed as a **constraint violation, not a content gap** — and every future language needed its own migration to widen a hardcoded list, which is exactly the manual step this work was asked to remove. Replaced with a foreign key to a new `supported_locales` registry: adding a language is now an INSERT (data), not DDL (a migration). Deliberately a table and not an enum for that reason. The migration back-fills the registry from whatever locale values the live tables already contain BEFORE validating the FKs — validating first would abort on production data nobody has looked at in a year. **Second structural gap:** neither table recorded what source text a translation was made from. `source_version_id` tracks the published *version*, which cannot see a single topic edited within one version; `nav_catalog_i18n` had no staleness mechanism at all. This is the same blindness that let `es`/`sr` sit two months stale at 100% "coverage" — coverage counts rows, and a stale row is still a row. Both tables gained `source_sha`, **not back-filled**: stamping legacy rows with today's hash would assert they match the current German, which is precisely the lie being cleaned up. **Pipeline shape, and the part worth keeping:** translations are **committed artifacts under `data/db-i18n/`, and the database is downstream of them**. The prior generator wrote straight to the DB, so nothing was reviewable in a PR, nothing was diffable, and re-seeding a rebuilt database meant paying for every translation again; `--from-artifact` now replays a locale with zero LLM spend — which is also the answer to repopulating Aurora post-migration. Only units whose `source_sha` moved are re-translated, which is what makes the second run of a language cheap. The hash is taken over an **ordered** field list — hashing the object directly would key on JS insertion order and report an entire locale as drifted when read through a different code path. Surfaces are a registry (`surfaces.ts`), so the seeder has no surface-specific branches and a third surface is a `SurfaceDef`. Validation encodes the four defects found in shipped catalogs during the 8-language expansion — renamed placeholders (repaired positionally; a changed *count* fails rather than being guessed), deterministic JSON truncation on long prose (**halve the batch and recurse — retrying reproduces it identically and is wasted spend**), formal register (hint carried per-locale in the registry), and verbatim source echo (reads as 100% coverage, renders as German). A unit is written whole or not at all. Length is deliberately NOT validated: a rule tuned on one language does not transfer — the naive French register regex in this same programme gave 39 false positives out of 41 because `rendez-vous` contains `vous`. **On the Aurora instruction:** all DB access goes through a new `db-i18n-repository.ts` seam (VTID-03498's B1 pattern) selected by `DB_I18N_TARGET=supabase|aurora`, default `supabase`. The `aurora` target is wired and **throws rather than falling back**, because it cannot execute yet for three independent reasons — the gateway has **no PostgreSQL driver at all** (it speaks HTTP to PostgREST; there is no connection string to swap), Aurora is the **DMS replication target** of Supabase so a direct write is the dual-writer hazard `SUPABASE-TO-AURORA-MIGRATION-PLAN.md` rejects as "Option C", and that plan's **Phase 0 gate is open** (~154k silently-dropped DMS applies, unreconciled). A quiet fallback would leave an operator believing Aurora was written when Supabase was — the VTID-03480 `ok:false` shape. Runbook: `docs/DB-CONTENT-I18N.md`. **Verified against a throwaway PostgreSQL 16** carrying the pre-migration schema plus an `nl` row deliberately absent from the release list: pre-migration an `fr` insert is rejected by the CHECK (the blocker is real, not theoretical), post-migration `fr`/`pt`/`ru`/`pl` insert, an unregistered locale is still rejected by the new FK (the constraint tightened rather than vanished), legacy rows stay `source_sha` NULL, the migration re-applies cleanly twice more (it will be applied by hand — see VTID-03492), and **adding Italian was one INSERT with both surfaces then accepting it, no DDL and no code change** — the acceptance test for "adding a language is automated". 39 new tests; the no-silent-fallback guard was mutation-verified (replacing the Aurora throw with a no-op fails 2 tests). **Known gap, unenforced:** `supported_locales` and vitana-v1's `languageOptions` must agree and nothing checks it; the registry is world-readable so the frontend can read it instead of holding a second copy. | VTID-03515 |
| 2026-08-06 | **OASIS spent six days asserting that almost all recent work had failed — 25 VTIDs marked `rejected`/`failed` for work that is merged and running in production.** Rule 1 of this file is "always treat OASIS as the single source of truth"; nothing ever asserted that the source of truth was telling it. **The writer, named outright by the event log:** a Claude Code session allocates a VTID and, per §4.1, sets `status='in_progress'` + `spec_status='approved'` on it. ~20-30s later `worker-runner-a1846580` claims it — because that tuple *is* the worker-runner's eligibility predicate — governance passes 3/3, every worker stage fails in under a second with `Failed to initialize Anthropic client — ANTHROPIC_API_KEY may be missing`, `vtid-terminalize` writes `terminal_outcome='failed'`, and `autopilot-controller.updateLedgerTerminal` maps that to `status='rejected'` (its own comment: *"use 'rejected' for failed tasks (shows red)"*). Correlation is total: **24/24 affected rows in the last 80 carry both a `worker_runner.claimed` event and the ANTHROPIC error**, and the autopilot event's timestamp matches the ledger's `updated_at` to the millisecond. `updated_at` is not auto-maintained here — writers set it explicitly — which is why batch-identical values across unrelated VTIDs were a real signal and not a coincidence. **The handoff's predicted irony held: VTID-03516, allocated to investigate this, was itself rejected 66 seconds after being set `in_progress`** — captured live as the reproduction case. **Ruled out along the way:** DB triggers (only two, both benign) and `self-healing-reconciler.ts` (writes `status='failed'`, not `'rejected'`, and only touches rows in `self_healing_log`). **The fix is an allowlist, and the reason matters:** a denylist of session-ish `metadata.source` values cannot work, because `source` is **free text** — sessions write ad-hoc labels (`orb-voice`, `aws-sns-gchat-alerts`, `news-feed-newest-first`), so most session-owned VTIDs carry no `claude` marker to match on. New exported `isAutonomousExecutionTask()` admits only `metadata.source='self-healing'` (the established discriminator four other call sites already key on) or an explicit `metadata.autonomous_execution=true`, enforced on the pending feed **and** on the claim write path — a worker can call claim with any VTID it likes, so the ownership check has to live on the authoritative write, not only on the read that suggested it. Cost of the reversal: **zero. Not one VTID in 60 days carries an autopilot execution link** — every VTID the worker-runner claimed in that window was session work it had no business touching. **The tempting wrong fix — populate `ANTHROPIC_API_KEY` on the worker-runner — would have been actively worse:** the missing key is the only reason each misfire failed in one second instead of the worker autonomously editing code for a VTID a session was concurrently working. **Detection** (the VTID-03480 lesson applied literally — a false verdict nobody alerts on is not detection): `ci_ledger_integrity_check()` RPC + daily `ALERT-OASIS-LEDGER-INTEGRITY.yml`, over PostgREST because psql-from-Actions is structurally dead here (VTID-03485/03492). It deliberately does **not** alarm on `terminal_outcome='failed'` in general — real failures must stay quiet or the check gets muted in a week — only on the fingerprint of a false verdict: claimed by a worker-runner, terminalized failed, not autonomous-plane work. Verified against production: **25 findings over 30d, 100% carrying the ANTHROPIC fingerprint; 0 expected once the gate is live.** **The 25 rows are NOT bulk-corrected**, and `scripts/oasis/correct-false-terminalizations.cjs` refuses to `--apply` without `--i-have-deployed-the-gate`: flipping all 25 to `success` would replace one false claim with another, since "the autonomous plane had no business judging this" is not "this work succeeded". Only the 14 with merged commits on `origin/main` get `success`; the rest have the verdict **voided** via `metadata.ledger_verdict_disputed` and are printed for human adjudication — absence of a merged commit is not proof of failure (some of that work landed in `exafyltd/vitana-v1`, some was investigation with no commit). Also worth its own look: `worker_registry` shows **two** worker-runners heartbeating 11s apart right now, which VTID-03508 flagged and "Never run parallel VTID executions" cuts against. 22 new tests; full suite 628/628 suites, 12205 passed. | VTID-03516 |
| 2026-08-06 | **AWS staging had been down for 4 days and the only signal was a red workflow nobody read.** Found while trying to PUBLISH VTID-03502/03510 to prod: `promote-staging` reads the commit staging serves from its build-info endpoint, and `preview-aws-gateway.vitanaland.com` was returning **503**. `AWS-STAGE-DEPLOY-GATEWAY.yml` had failed **9 consecutive runs since 2026-08-02** — image built, task def registered, then `aws ecs wait services-stable` timed out at 10 min every time. **Root cause:** six task-def secrets pointed at `vitana/gateway/prod/*`, a namespace that **does not exist** in Secrets Manager (`SUPABASE_JWT_SECRET`, `SUPABASE_ANON_KEY`, `GOOGLE_GEMINI_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`). ECS cannot start a task whose secret it cannot fetch — `ResourceInitializationError … ResourceNotFoundException` — so the service never stabilised. **The mechanism that made it permanent is the lesson:** this deploy mutates the *previous* task definition in place and only ever rewrote `.environment`, so it cloned `.secrets` forward untouched — one bad reference propagated to every subsequent deploy, and it was invisible in code review because **task-def secret wiring existed only in live AWS state, never in this repo**. The workflow now RESOLVES each secret via `describe-secret` and upserts the full ARN on every deploy, which both fixes it and makes a future hand-edit self-correcting. **A second, subtler defect surfaced during the fix and is the more reusable lesson:** ECS `valueFrom` requires the **complete** ARN *including* the six-character random suffix Secrets Manager appends (`…jwt-secret-AbCdEf`). A name-only ARN is accepted by the CLI's `--secret-id` — which is why `get-secret-value` worked fine for a hash comparison — but ECS rejects it as `ResourceNotFoundException`, **indistinguishable at a glance from a secret that does not exist**. The first repair attempt constructed ARNs by string concatenation and therefore failed identically on a secret that demonstrably existed. ARNs must be looked up, never built; `describe-secret` also fails the job immediately on a missing secret instead of registering a task def that cannot start and surfacing it 10 minutes later as a stabilise timeout. `SUPABASE_JWT_SECRET`/`SUPABASE_ANON_KEY` deliberately resolve to `vitana/supabase/prod/*` — the same secrets prod uses — because AWS staging talks to the **prod** Supabase project (its `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE` already did); a JWT secret from another project would deploy green and break every login. Confirmed by sha256: `vitana/gateway/staging/supabase-jwt-secret` holds an identical value, so either choice works. **Diagnosis discipline worth keeping:** the two obvious suspects were both checked and *both wrong* — the VTID-03481 migration WAS applied (`revoked_at`/`revoked_reason` present), and neither the workflow nor the Dockerfile had changed since 07-28. **Also found, not fixed:** `AWS-PROD-DEPLOY-GATEWAY.yml` clones `.secrets` forward the same way. Prod's references are all valid today so it has never bitten, but the identical fragility is one bad edit away — its own follow-up. **Consequence for the publish that triggered this:** prod is still on `d6861094` (2026-08-04) and is **5 commits behind**, so VTID-03501/03502/03504/03510 are all merged but NOT live — including VTID-03504's ORB context-bootstrap stampede fix. Nothing ships until staging is verified green. | VTID-03513 |
| 2026-08-06 | **ORB voice replies landed in the "Vitana" Messenger thread immediately but never told the client — reported live as "nothing shown in 24 hours."** `bridgeVoiceTranscript()` (`orb/live/session/upstream-message-handler.ts`) has always written each voice turn straight into `chat_messages` synchronously, per-turn — there is no cron/batch/extraction delay anywhere in that path. The actual gap: unlike the typed-message path (`chat.ts` `/send`, which calls `notifyUser(...)` for every Vitana reply to a human), the voice bridge only ever did a raw insert with no notification call at all. With no push and a Realtime subscription that's both scoped to `receiver_id=eq.user.id` and only alive while the Messages screen is mounted, plus a 10-minute React Query `staleTime`, the only way the user found out a reply existed was reopening Messenger and getting lucky with a background refetch — anywhere from minutes to 24h+. Fix: `bridgeVoiceTranscript()` now returns whether the write actually succeeded (was `void`), and a new `notifyOrbVoiceBridgeWrite()` fires the exact same `new_chat_message` push+inapp notification `chat.ts` already sends for a bot reply, gated on a confirmed write and only for the Vitana→user leg (the user's own transcribed speech doesn't need a push). Deliberately did not touch the LiveKit ORB path (`orb-livekit.ts`) — it has no `chat_messages` bridge at all, a separate, narrower gap affecting the single LiveKit canary user, out of scope for this report. 8 new/updated tests in `chat-bridge-reliability.test.ts`. | VTID-03520 |
| 2026-08-06 | **97.5% of the Gemini Live bill was sessions nobody was talking to — the sweep reaped on age, not on idle.** Chasing "Gemini API is the biggest remaining line item, cut it", the actual billing CSV showed Gemini API at **$92/mo** while `llm.call.completed` measured only **$5.75/30d** — so ~94% of that line never emitted the telemetry the earlier analyses relied on. The unmeasured path is ORB Live (`generativelanguage`, billed per second of open stream), and `vtid.live.session.stop` over 7 days named it exactly: `expired_ttl` — **132 sessions, avg_turns 0.0, avg 32.4 min, 97.5% of ALL billed minutes**; `superseded_by_new_session` 2.3%; genuine conversation **12 minutes a week**. **Mechanism:** `liveSessions` owns the upstream Gemini WebSocket, and its sweep purged purely on `createdAt > 30min` while ignoring the `lastActivity` field that already existed on the session and was already bumped on every inbound audio chunk. An idle-based sweep even existed — over `wsClientSessions` (the client socket map), not `liveSessions` (the billed upstream). That gap is the whole bug. New exported pure predicate `classifyIdleSession()` returns the close reason or null: 5 min idle with `turn_count===0 && audioInChunks===0` → `idle_no_engagement`, 10 min idle after real engagement → `idle_timeout`, 30 min absolute → `expired_ttl` (**reason string deliberately unchanged so existing dashboards still mean what they meant**), and the absolute cap wins so the buckets never double-count. Sweep interval 5 min → 60s, because a 5-minute budget checked every 5 minutes yields up to 10 minutes of billed idle. **Audio-OUT is deliberately NOT engagement:** a model monologuing to a user who left is exactly the VTID-03480 signature, and keeping that stream alive burns money *and* hides the fault — the distinct reason makes it more visible, not less. Emits `idle_ms` on the stop event so the saving is auditable (`duration_ms` alone can't separate a 5-minute reap from a 32-minute one). **Correction worth keeping: my own earlier cost estimates were ~2x too high** because I priced every `min-instances=1` service at the *active* CPU rate; Cloud Run bills a throttled idle min-instance at ~1/10th that, so only `orb-agent` (which had `--no-cpu-throttling`) ever cost what VTID-03508 claimed. That also inverts the `worker-runner` trade — ~$5-8/mo, not $65, so it is not worth an AWS verification round. **Also decided NOT to do:** routing planner/operator to Claude via the Bedrock adapter. The active policy (v10) points those stages at provider `vertex`, which bills under the *Vertex AI* line ($21/mo), not the Gemini API line — the swap targets ~$5.75/mo, needs `BEDROCK_ROLE_ARN` on the task def, and changes the model behind autopilot planning. Cost noise for a behaviour change. Separately noted for its own investigation: the planner is running `gemini-3.1-pro-preview` at **~90s latencies** and fired twice within the same second on two different `VTID-DA-FIND-*` findings. One pre-existing test broke and was **tightened rather than loosened** — `nova-close-reasons.test.ts` asserted the literal `'zombie_sweep_max_age'`; the taxonomy it guards got finer (three named causes), so it now asserts all three plus the template form. 9 new tests; full suite 627/627 suites, 12183 passed. | VTID-03510 |
| 2026-08-06 | **Cut GCP standby billing without shutting anything down — and corrected a "load-bearing" call that had been made from config comments instead of usage data.** Directive was: keep Vertex Imagen and Google Cloud TTS on GCP as pay-per-call APIs, but stop paying for idle instances. Those two goals never conflicted — **Imagen and Cloud TTS are per-call APIs and require no Cloud Run instance of their own**, so nothing about the provider-replacement programme (§2c/§2d) is needed to stop the bleeding. The spend is standby, and the 2026-08-03 analysis had already measured that AI is **$5.42/30d** total. Three services scaled to zero: `gateway` (already config-changed by VTID-03491; zero live traffic since the 07-27 AWS cutover, stays deployed as the rollback target), `gateway-staging` (~$69/mo), and **`vitana-orb-agent` (~$150/mo — the largest single item)**. **The orb-agent call reverses VTID-03491's own "YES — do not change" verdict, and the reason is the lesson:** that verdict was inferred from the deploy workflow's own comment asserting the warm worker was load-bearing. Checked against live data instead, `voice.livekit_canary_allowlist` holds **exactly one user** and `oasis_events` shows **zero** LiveKit room-join/agent-dispatch events in 90 days — the only `orb.livekit.*` topics still firing are `next_action.*`, which is gateway-side suggestion logic that never touches this service. Reading config tells you what a service is *set up* to do; only the event log tells you whether anyone does it. **This is an on/off, not a tuning:** the livekit-agents worker connects OUTBOUND to LiveKit Cloud and must stay resident to receive dispatches, so at `min-instances=0` it deregisters and the path is dead rather than slow; `--no-cpu-throttling` is equally mandatory (a throttled instance starves the persistent outbound session between requests). The two therefore move together and there is no cheap-and-functional middle setting. Made reversible as a `warm_worker` **dispatch input** (default false) rather than a hardcoded 0, so restoring LiveKit voice is a button, not a PR. `gateway-staging` keeps its documented regression — a cold ORB `session/start` is ~9.4s vs the widget's 8s abort, so the **first** ORB open after idle goes silent on staging; accepted deliberately (preview env, prod is on AWS) with the warm-up curl documented at the call site. **`worker-runner` was deliberately NOT touched**, and not because it is cheap: `worker_registry` shows two worker-runners heartbeating seconds apart, but it records no cloud attribution, so the DB cannot show whether the second poller is the AWS ECS twin (VTID-03411) or a second GCP revision — and guessing wrong stops the canonical autopilot pipeline **silently** (VTID-01206 pinned min=1 precisely to keep polling alive). One `aws ecs describe-services` call settles it. Two simultaneous pollers is itself worth a look against "Never run parallel VTID executions". **Workflow edits bind only on each service's next deploy**, so `scripts/gcp/scale-idle-to-zero.sh` applies the same three changes to the live services immediately (`--apply`, `--restore` to reverse, dry-run by default), refuses to touch `worker-runner`, and documents why the Serverless VPC connector (min=2, ~$15-70/mo) cannot be scaled at all — 2 is the platform minimum, so it can only be deleted, and only once Memorystore is confirmed unused. | VTID-03508 |
| 2026-08-05 | **A test account posted to production and 192 real members got the push.** Between 14:54 and 15:00 UTC the shared E2E account (`e2e-test@vitana.dev`, the one both CLAUDE.md files name for Playwright/API testing) created 5 public `profile_posts` against **production** while reproducing VTID-03503 (feed like/comment counts vanishing after refresh) — the reproduction needs a post to like and comment on, and it was made where real people live. `trg_notify_community_post` (vitana-v1 migration `20260630120000`) fans out to **every member of the author's tenant**, so 5 inserts became **960 `user_notifications` rows and 600 delivered pushes**: "E2E Test User shared a new post" / "…hat einen neuen Beitrag geteilt", reported from a member's lock screen. The posts were deleted right after; that recalled nothing, because a push is gone the instant it is sent and the notification rows outlive the post they deep-link to (tapping one now 404s). **Nothing authorized this and nothing could have stopped it:** the fan-out trigger only asks "is this post public?", the test account is a full member of the production tenant, and both CLAUDE.md files said to use it for "Playwright screenshots, API calls" without ever scoping that to a non-production host. It signed into prod ~25 times on 2026-08-05 alone. **Fix, two independent layers** (vitana-v1 migration `20260805160000`): (1) `notification_test_actors` + `_notif_is_test_actor()`, matching the registry **or** the `e2e-%@%` / `%@vitanatest.exafy.io` email patterns — the patterns matter because e2e accounts get minted ad hoc and an unregistered one created tomorrow would blast the community exactly the same way; (2) a BEFORE INSERT sink guard on `user_notifications` reading whichever actor key the producer used (`actor_id`/`sender_id`/`reactor_id`/`follower_id` are all in live use), because guarding only the two publish triggers covers what exists today and nothing written next month. The sink guard **fails open** — any cast or lookup error delivers the notification, since suppressing test noise is worth strictly less than one real member's notification going missing. Source-side early returns added to both community publish functions too, so the rows are never generated rather than generated and dropped 192 times. Verified on prod: predicate true for both e2e accounts and false for a real user, a test-actor notification insert returns 0 rows while a real-actor and a malformed-actor insert both survive, and a full public post inserted as the test account inside a self-aborting `DO` block produced **fanout_notifications_created=0**. The 960 rows were snapshotted to `_vtid_03506_purged_notifications` and deleted. **The guard is a seatbelt, not a permission slip** — it silences notifications, it does not keep test posts, comments or chat messages out of the real feed; new hard rules 31/32 above forbid the write itself. | VTID-03506 |
| 2026-08-05 | **An ORB stuck on "Verbinden..." on one iPhone was a context-bootstrap stampede that degraded three users.** Reported with two photos of a phone; nothing else surfaced it. `orb.live.context.bootstrap` had run a **2.0s p50 all day** and then **17.4s p50 / 119.7s max between 14:14 and 14:22 UTC**, with `vtid.live.session.start`+`stop` pairs repeating every 10-30s — the widget's reconnect loop, recorded server-side. **No deploy was involved** (the gateway had been on `d6861094` since 08-04) and the infrastructure was healthy throughout: session/start 1.4s, SSE and WS both fine, and by 14:29 the same call was back to 1.6s. It was pure load amplification. **The mechanism, and why the obvious fix would have been a no-op:** `system_controls.vitana_brain_orb_enabled` is TRUE, so live sessions build context through `buildBrainSystemInstructionCached`, **not** the legacy `buildBootstrapContextPack` that the prewarm endpoint and most of the tuning work target. That wrapper is gated on `FEATURE_ORB_BRAIN_CACHE`, which `GET /api/v1/admin/feature-flags` reported as `env_var_present:false, live:false` on prod — so it was a **transparent passthrough**, and the thing it was passing through was not just the TTL cache but the module's own documented **"concurrent-build de-dupe … so prewarm + the tap share ONE build instead of stampeding."** Every tap and every reconnect therefore started its own full ~10-Supabase-round-trip build; the builds starved each other; each got slower; the client's 8s budget expired sooner and fired another reconnect. Two uninvolved users on the same task were dragged to 97s and 119s. `warmBrainCache()` — the entire point of `/live/session/prewarm` — was likewise a no-op, so the prewarm only ever warmed the path the brain build never reads. **Fixes, in order of how much they matter:** (1) **single-flight de-dupe no longer depends on the caching flag** — a stampede guard that only works when an unrelated experiment is switched on is not a guard. An in-flight entry is now joined unconditionally, and joined *regardless of TTL*, since TTL describes how stale a finished build may be and says nothing about one that has not produced a value yet. Flag-off still drops the entry on settle, so the documented passthrough semantics are unchanged. (2) `FEATURE_ORB_BRAIN_CACHE_ENV=staging+prod` pinned in `AWS-PROD-DEPLOY-GATEWAY.yml` beside `FEATURE_ORB_FAST_START_ENV`, same rationale and same measured-evidence bar as BOOTSTRAP-ORB-FASTSTART-DRIFT — carried-forward task defs never acquire a flag on their own. (3) The legacy `buildBootstrapContextPack` got the same single-flight (it had none at all), plus bounds on its two **unbounded** fetch legs — only the profiler leg had ever been capped, so the build's true worst case was "however long Supabase takes". The caller's wait is bounded at 6s while the build itself runs on to warm the cache, so the retry lands warm instead of starting a third copy. (4) New hourly `ALERT-ORB-BOOTSTRAP-LATENCY.yml` over PostgREST (no migration — `oasis_events` is already reachable by `service_role`); **verified by replaying the real incident rows through it: p50 27623ms, 15 builds over 12s, exits 1**, and it stays quiet on the healthy 11:00 window and on an idle window. **The trap worth keeping:** a `Promise.race` timeout wrapper placed over a fetch *also swallows that fetch's rejection message*, turning `error: supabase timeout` into a bare `timeout` and losing the cause. The existing suite caught it; the memory leg now keeps its own `.catch` so only a real timeout reports one. 5 new brain-cache tests + 3 new bootstrap tests; full suite 624/624 suites, 12156 passed. | VTID-03504 |
| 2026-08-05 | **Nova Sonic premature-close-at-open now falls back to Vertex mid-session** — the safety half deliberately left out of VTID-03501's promotion flag. Nova drops **10.2% of sessions** (6/59, evenly spread 2026-07-29 → 08-05 — a steady baseline, not a recent regression) with diagnostic `"Premature close"`: the bidirectional stream dies at open with `audio_out=0`, `audio_in=0`, `turn_count=0` and `greeting_sent=true` — the greeting was written to a stream that never delivered a byte, so the user sits in silence with the widget looking connected. `audio_out === 0` is a **perfect** discriminator: it appears under no other close reason, and every healthy mid-conversation drop has `audio_out > 0`. New exported pure predicate `shouldFallbackToVertexOnNovaClose()` (`routes/orb-live.ts`) requires ALL of: session active, close **not** initiated locally, no rotation in flight, `audio_out === 0`, and not already fallen back. On a match it pins `_novaFallbackToVertex = true` and runs the existing `attemptTransparentReconnect()` — the user gets a working Vertex session instead of silence; if that also fails, it falls through to the pre-existing `emitConnectionIssue` path rather than swallowing the error. **Getting the predicate wrong is worse than not having it:** too broad sends healthy mid-conversation drops to Vertex (losing Nova for no reason and masking real Nova behaviour), too narrow leaves the 10% silent — hence the predicate is extracted as a pure function with 7 tests pinning every negation independently, rather than living as an inline condition. The `alreadyFellBack` guard exists because a Vertex reconnect that *also* closes with zero audio would otherwise re-enter the fallback forever. Emits diag `nova_premature_close_fallback` + OASIS `orb.upstream.nova.premature_close_fallback` so the rate stays measurable after mitigation. **This mitigates the 10%, it does not fix it** — the "Premature close" root cause is still unknown and needs CloudWatch-level investigation before Nova is healthy enough to promote globally. Full suite 626/626 suites, 12166 passed. | VTID-03502 |
| 2026-08-05 | **Nova Sonic global promotion path — build 4 of 4, shipped OFF and deliberately INCOMPLETE.** New `NOVA_SONIC_GLOBAL_ENABLED` (default false, exact-string `'true'`) promotes Nova out of the canary allowlists onto every session; allowlist semantics untouched so switching off restores the exact prior population. Promotion widens who, never what — `enabled`/language/`aws-ecs` gates all still apply. New selector reason `nova_global_enabled` with **`canary: false`**, plus `global_enabled` on the health payload, because otherwise every canary-scoped dashboard would keep reporting "4 users" while Nova served everyone. See §2e. **Root-caused the failure that gates actually using it:** Nova fails **10.2% of sessions** (6/59, 2026-07-29→08-05, a steady baseline not a spike), all six with the identical diagnostic `"Premature close"` — the HTTP/2 bidi stream dying at open with zero audio in/out and `greeting_sent=true`, i.e. the user opens ORB and hears silence with no error. `audio_out=0` is perfectly correlated with this reason and appears under no other. Nova's own `nova_validation` text confirms a hard ~295s stream inactivity deadline; the HTTP/1.1 workaround from §2b is unavailable because `InvokeModelWithBidirectionalStream` requires HTTP/2. **The runtime Vertex fallback for this case is NOT in this VTID** — `_novaFallbackToVertex` + `attemptTransparentReconnect()` already exist (used by `nova_rotation_exhausted_fallback`) and are the right vehicle, but wiring them to the premature-close-at-open path is a separate change that deserves its own careful review rather than being appended to this one. **Do not set the flag until that lands.** Also corrected: an earlier claim in this session that `nova_stream_error` carried no error detail was wrong — the diagnostic is and was persisted on `orb.live.diag` `stage=upstream_error`; a telemetry VTID opened for it (VTID-03499) was cancelled without any code. 11 new tests; full suite 621/621 suites, 12116 passed. | VTID-03501 |
| 2026-08-05 | **Amazon Titan Image Generator — build 3 of the 4 that gate a GCP shutdown**, and the only one Claude cannot cover at all (Imagen generates images; no Anthropic model does). New `providers/titan-image.ts` behind `IMAGE_PROVIDER=vertex\|bedrock` (**default `vertex` — deploying this flips nothing**), see §2d. **Found a second Imagen consumer the cutover changelog had missed:** `intent-cover-service.ts` does plain text-to-image alongside `cover-image-outpaint.ts`'s outpainting — a Titan build covering only outpainting would have left AI cover generation silently broken on shutdown. Both are now wired (`TEXT_IMAGE` / `OUTPAINTING`). Three Titan constraints handled explicitly: (1) **Titan accepts only fixed width/height pairs and 1600x900 is not one** — `nearestTitanSize()` maps to 1280x720 and weights **aspect above area**, because satisfying 16:9 with a square would letterbox the subject invisibly; the outpaint path upscales back. (2) **Mask polarity is inverted vs Imagen and is UNVERIFIED** — white=generate for Imagen, black=generate for Titan; backwards means the *subject* is regenerated and the margins kept, a plausible-looking but totally wrong image. Env-overridable via `TITAN_OUTPAINT_MASK_POLARITY` so it can be corrected without a redeploy; mask resized with `kernel:'nearest'` to stay two-tone. (3) **Titan isn't offered in every region** — `AWS_TITAN_IMAGE_REGION` is its own var rather than inheriting eu-central-1. Also: Titan reports content-policy blocks in an `error` field **on a 200**, not by throwing. **Correction to the draft spec:** it cited an "existing letterbox-blur fallback" as Titan's safety net — that is the *frontend's* old behaviour; `routes/cover-images.ts` just returns an error, so there is no server-side safety net. `scripts/images/verify-titan-image.ts` checks region/model, the size mapping, and detects inverted mask polarity via a deterministic red-subject probe. 16 new tests; full suite 620/620 suites, 12105 passed. | VTID-03497 |
| 2026-08-05 | **Bedrock adapter: vision + forced tool-calling — build 2 of the 4 that gate a GCP shutdown.** Removes the blanket `images/tools not supported` rejection in `bedrockAdapter` (§2b). Bedrock speaks the same Anthropic Messages API wire shape, so images become content blocks and `tools`/`forceTool` become `tools` + `tool_choice`, mirrored line-for-line from `anthropicAdapter` so the two stay diffable; `tool_use` responses surface as `AdapterResult.toolCall`. This is the piece `anthropic-vision-client.ts` (Shorts auto-metadata) needed — images **and** a forced `emit_short_metadata` call, the exact combination previously rejected. **Two latent bugs found and fixed while building, both silent:** (1) `tools` was on `BedrockInvokeRequest` but never serialized into the body — passing tools produced a plain completion with no tool call and no error; (2) text was read from `content[0].text`, which is **empty when a forced `tool_use` block is first**, so it would have returned empty text on every vision call. Also moved `BEDROCK_ROLE_ARN`/region reads from module-load to call-time, so setting the var on a task def no longer needs a process restart (and can be tested). Text-only calls still send a plain string `content`, byte-identical to VTID-03403. Still dormant until `BEDROCK_ROLE_ARN` is set and an operator points a stage at `'bedrock'` — deploying this changes no routing. 9 new tests; full suite 619/619 suites, 12089 passed. | VTID-03496 |
| 2026-08-05 | **Amazon Polly TTS provider — build 1 of the 4 that gate a GCP shutdown.** New `services/tts/polly.ts` + `services/tts/tts-provider.ts` seam; all 4 Google Cloud TTS synthesis call sites route through it, selected by `TTS_PROVIDER=google\|polly` (**default `google` — deploying this flips nothing**). See §2c. Three Polly divergences that are NOT cosmetic: (1) **Polly has no Serbian voice in any engine** — `sr` is a live locale (§13b), so `resolvePollyVoice('sr')` returns null and falls back to Google rather than substituting English; with GCP gone, Serbian TTS has no provider at all, an unresolved shutdown blocker. (2) **Polly PCM is 8k/16k only, not 24k** — `synthesizeGreetingBridgeAudioPcm()` now returns `{audioB64, sampleRateHz}` and the `audio/pcm;rate=` mime is built from it; assuming 24kHz would play Polly audio 1.5× fast, audible to a user but invisible to a bytes-came-back test. (3) **No `speakingRate` field** — rate becomes SSML `<prosody>`, forcing XML-escaping (plain text kept at rate 1.0). Polly Russian is standard-engine only. Fallback polly→google is always logged; `TTS_POLLY_STRICT=true` disables it for shutdown rehearsals. The admin voice-preview route takes an explicit `provider:'polly'` param and deliberately ignores `TTS_PROVIDER` so previews can't lie; the Cloud-TTS debug route stays Google-only by design. **Voice table and the Serbian gap were derived from Polly's documented voice list, not verified against the live API** — the building session had no AWS credentials; confirm via `describe-voices` before flipping. 18 new tests. | VTID-03495 |
| 2026-08-04 | **Finished the job the row below started: `psql` from GitHub Actions is now gone from this repo entirely.** VTID-03485/03486 found that the Supabase network allow-list makes `psql "$SUPABASE_DB_URL"` unusable from Actions and converted two workflows; the other six were left broken. All six are now migrated, and they split into two classes that need genuinely different answers. **(a) Read-only health checks** (`ALERT-WELCOME-GREETING-HEALTH`, `SMOKE-WELCOME-GREETING`, `MORNING-SYSTEM-HEALTH-CHECK`) → PostgREST RPCs, same pattern as VTID-03486: two new `service_role`-only SECURITY DEFINER functions (`ci_welcome_greeting_health`, `ci_system_health`) in migration `20260804100000`. The morning check's five separate psql steps collapse into one step with two RPC calls, same five report rows. **(b) Migration runners** (`RUN-MIGRATION`, `RUN-STAGING-MIGRATION`, `VTID-02409-BOOTSTRAP`) apply migration FILES — arbitrary DDL, which **PostgREST fundamentally cannot do**. The tempting shortcut, an RPC that `EXECUTE`s caller-supplied SQL, is a remote-DDL-execution endpoint on production and was deliberately NOT built. These use the **Supabase Management API** (`api.supabase.com`, a control-plane service not subject to the DB allow-list) via new `scripts/ci/apply-sql-via-management-api.sh`. **This requires a `SUPABASE_ACCESS_TOKEN` repo secret that does not exist yet — until someone adds it, those three fail immediately with an actionable message rather than silently.** The other five work today on existing secrets. Two traps worth keeping: (1) the script's `--single-transaction` (replacing `psql -1`) **skips wrapping when the file already contains its own `BEGIN`** — a nested `BEGIN` is only a warning, but the file's own `COMMIT` would then close the outer transaction early and the rest would run unprotected, silently losing the atomicity the flag exists to give. (2) `RUN-STAGING-MIGRATION`'s HARD GUARD (the prod-block that refuses to run if the target isn't staging) validated `STAGING_SUPABASE_DB_URL`; switching the apply step to `STAGING_SUPABASE_URL` would have left the secret that *actually* selects the target project unchecked — the guard was retargeted, not just carried over. **Strong suspicion worth investigating separately: a dead `RUN-MIGRATION` is a very plausible cause of VTID-03486's 103 declared-but-absent tables** — the canonical way to apply a migration in CI could not connect, so migrations were applied by hand, which also explains why recorded versions never match file versions. Also noted: CLAUDE.md §3's `vtid_ledger` table lists `claimed_until`, but the real column is `claim_expires_at` (+ `claim_started_at`). | VTID-03492 |
| 2026-08-04 | **The two VTID-03480 follow-ups: make a fail-soft failure loud, and catch never-applied migrations.** (1) `orb-session-state.ts` now tracks read/write/clear outcomes in-process. Instrumentation sits inside the three helpers rather than at the ~25 call sites, so nothing has to opt in and nothing can bypass it. Loudness is rationed deliberately: three consecutive failures before an op counts degraded (one blip is not news), a single grep-able `ORB_SESSION_STATE_UNHEALTHY` line on the healthy→unhealthy transition rather than per failure (§6's "repetition ≠ signal"), and re-log at most every 15 min. A missing relation is treated as conclusive on the *first* occurrence — that is the VTID-03480 signature, not a transient. One real behaviour change: a read that errors is now distinguished from a read that finds no row; both still return `null` to the caller (fail-soft contract intact), but only the latter counts as healthy — the old code could not tell "first session for this user" from "table is gone". New admin-gated `GET /api/v1/admin/orb-session-state-health` returns 503 when unhealthy so an uptime check alarms without parsing the body, plus `ALERT-ORB-SESSION-STATE-HEALTH.yml` (daily) which asserts the relation exists, that writes land when there was real traffic, and that no ack reports `ok:false`. (2) `MIGRATION-DRIFT-CHECK.yml` + `scripts/ci/check-migration-drift.cjs`. **The literal ask — "every migration file has a matching applied version" — turned out to be unimplementable here, and the reason matters:** the repo's 377 distinct file-version prefixes and the 330 rows in `supabase_migrations.schema_migrations` **overlap by 2**. Migrations reach this database by several routes (dashboard SQL editor, MCP `apply_migration`, direct psql) and most record a *fresh* timestamp instead of the file's own version — applying the VTID-03480 migration (file `20260606000000…`) on 08-03 was recorded as version `20260803202122`. Version bookkeeping is simply not a record of what ran, so that check would have been red on day one with ~375 false positives and switched off within a day. The check instead asserts the property that actually caught VTID-03480: if a migration declares `CREATE TABLE x`, then `x` must exist. **This immediately found that VTID-03480 was not a one-off — 103 tables are declared by migrations and absent from production**, including three this very file documents as canonical (`products_catalog` and `services_catalog` in §3's Core Tables, `relationship_signals` in §14's relationship-graph diagram). None are dropped by a later migration; their SQL simply never ran. Recorded in `scripts/ci/migration-drift-baseline.json` so CI fails only on **new** drift — a visible backlog to shrink, not an amnesty. (3) **Every `psql`-from-GitHub-Actions health check in this repo is dead and has been for at least 6 days.** Both new workflows were first built on the established `psql "$SUPABASE_DB_URL"` pattern; the drift job failed on its first CI run with `FATAL: (EADDRNOTALLOWED) address not in tenant allow_list` — the Supabase project has a **network allow-list and GitHub runner IPs are not on it** (they differ per run, so allow-listing them is not practical). `ALERT-WELCOME-GREETING-HEALTH.yml` has failed *every* scheduled run since at least 07-29 with the identical error, and the other workflows on the session's "known-chronic failures, don't chase" list are the same 8 files that reference `SUPABASE_DB_URL` — they are not flaky, they are structurally unable to connect. Shipping this follow-up on that transport would have produced a detector that cannot run: the exact failure mode VTID-03480 is about. Both workflows now go over **PostgREST/HTTPS** (a separate edge service, not subject to the DB allow-list) using the `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE` secrets that already exist, via two `service_role`-only SECURITY DEFINER RPCs (`ci_schema_inventory`, `ci_orb_session_state_health`) in migration `20260804080000`. **The remaining 6 psql workflows are still broken and were left alone — that needs its own VTID.** One subtlety worth keeping: `ci_schema_inventory` must match on `relkind IN ('r','p')`, not `'r'` alone — `'p'` is a partitioned parent (`memory_audit_log` is one, and a migration declares it), and filtering to `'r'` reported it as missing. Caught by a 509-vs-510 count mismatch against `information_schema`. | VTID-03485, VTID-03486 |
| 2026-08-05 | **Messenger history was never deleted — three independent caps made most of it unreachable, and one of them dropped whole conversations at random.** Reported as "the chat history is more or less completely gone." Nothing had been removed: `chat_messages` held 39,593 rows going back to 2026-02-27. (1) **The inbox itself was lossy.** `get_recent_conversations()` ends its `DISTINCT ON` pass with `ORDER BY peer_id, created_at DESC` — `DISTINCT ON` forces the ORDER BY to lead with the distinct key — and then applied `LIMIT p_limit` to *that*. So "the 50 most recent conversations" was really "50 conversations sorted by a random UUID": for the member with 199 conversations, only **7 of their 20 most-recently-active chats** were returned at all. Fixed by wrapping the `DISTINCT ON` result in an outer `ORDER BY created_at DESC LIMIT` (migration `20260805120000`), and raising the gateway's cap 50 → 250 (198 of 220 users have more than 50 conversations). (2) **Thread scrollback was dead code.** `ConversationView` renders `useHybridMessages`' React Query array, but its scroll-to-top handler drove `usePaginatedMessages` — a completely separate state array that was never rendered, and whose `fetchInitialMessages` was gated behind `shouldUsePagination` (`messages.length > 50` on that same always-empty array). Circular, so `hasOlder` was permanently `false` and scrolling up did nothing: every thread was frozen at its newest 50 messages, putting **15,444 of 39,593 messages (39%) permanently out of reach**. Replaced with real paging through the gateway's already-existing `before` cursor, accumulated per-thread OUTSIDE the query cache — realtime invalidation refetches that cache on every incoming message and would otherwise discard scrollback mid-conversation. (3) **Group threads and both DB fallbacks paged the wrong end.** `fetchLegacyMessages` and the `chat_messages` fallbacks used `.order('created_at', {ascending: true}).limit(100)`, which returns the OLDEST 100 rows — a busy group chat showed its first-ever 100 messages and never the recent ones. Now fetched newest-first and reversed for render. **Lesson worth keeping:** a `LIMIT` after `DISTINCT ON` is not "top N", it is "N arbitrary rows" — and dead pagination is invisible precisely because the first page always looks right. | VTID-03493 |
| 2026-08-03 | **`orb_session_state` never existed in production — four ORB features were silently dead for ~2 months.** Investigating a live report of ORB voice failing on mobile, every session was found to emit `orb.session.audio_ready.acked` with `ok:false`. That `ok` is not the client's readiness — it is the return of `writeOrbSessionState()`, and the write was failing because `relation "orb_session_state" does not exist`. Migration `20260606000000_DEV_COMHU_0503_orb_session_state.sql` was authored but never applied (its own header: "Not executed from the sandbox"); the applied-migrations list jumps `20260605…` → `20260609…`. Because every helper in `orb-session-state.ts` fails soft by design (reads → `null`, writes → `{ok:false}`, never throws), nothing surfaced: the **audio-ready handshake** (greeting fell back to a blind 3s timer and could be spoken before the client could play it — the silent-ORB symptom), **close/reopen continuity**, the **pending autopilot CTA**, and **wake-brief opener rotation** were all inert. Applied the migration to prod; `audio_ready.acked` flipped `ok:false` → `ok:true` on the next live session with **no redeploy**, confirming the code had always been calling it correctly. Session telemetry that made this findable: 29 sessions ended `expired_ttl` at ~32 min with `turn_count:0` and `audio_in_chunks:0` while `audio_out` climbed normally — the model spoke, the user never heard it, so nobody ever replied. **Lesson worth keeping:** a fail-soft table with no health check is undetectable — `ok:false` in a payload nobody alerts on is not detection. Documented in `DATABASE_SCHEMA.md`. | VTID-03480 |
| 2026-08-01 | **Decided (not yet built) the concrete AI/voice provider replacements for the GCP full-cutover draft spec**, at explicit user request. `docs/vtids/VTID-PENDING-GCP-FULL-CUTOVER-SPEC.md` preconditions 3–5b updated: ORB voice → Amazon Nova Sonic (promoted out of canary, replacing Vertex Live entirely, no GCP fallback retained); TTS → Amazon Polly (replacing Google Cloud TTS across all 4 call sites); non-voice text AI → Claude via the existing Bedrock adapter. Two gaps surfaced while confirming these are actually buildable: (1) `cover-image-outpaint.ts` calls Vertex **Imagen** for image *generation*, which Claude cannot do at all — decided to build a separate Bedrock Titan Image Generator adapter for this one feature, with the code's existing letterbox-blur fallback as the safety net if output quality doesn't hold up; (2) at least one feature (`anthropic-vision-client.ts`'s Shorts auto-metadata) needs vision + forced tool-calling, which the Bedrock adapter doesn't support yet (CLAUDE.md §2b) — decided to extend the adapter rather than carve out a permanent exception. This removes the "or accept a written exception" branch the draft spec previously had for AI/voice providers — decided 2026-08-01, so the only open question is now build sequencing, not the target. Documentation only; no code changed yet. | (draft spec update, no VTID) |
| 2026-08-02 | **Regression from VTID-03447 (2 days old): ORB opened every voice session with the same name greeting.** Live report — three ORB opens inside one minute each produced an identical "Guten Tag Dragan! Ich freue mich, dich bei Vitanaland zu sehen." VTID-03447's `=== AUTHORITATIVE USER NAME ===` header (`services/gateway/src/orb/live/instruction/live-system-instruction.ts`, shared by the Vertex AND Nova Sonic raw-WS transports) did not just state the name — it said "**Greet them** and address them by this name — 'Hi <Name>', 'Hallo <Name>'", i.e. an unconditional greeting instruction plus two literal greeting templates, pinned at maximum structural prominence at the top of the prompt. That outranked all three mechanisms that are supposed to decide the opener: the per-turn opening directive (whose short-gap/reconnect rungs — `safe_fast_pending_context`, `conv_resume` — explicitly say *"Do NOT say 'Hello' or the user's name"*), the `VTID-02637 RECONNECT SILENCE RULE`, and the `FLEXIBLE WORDING — ABSOLUTE` rule ("never speak a fixed, memorised greeting; NEVER open two conversations with the same sentence"). Since the greeting text is model-composed, not a catalog string, this shows up as a fixed opener no cadence logic can suppress. Fix: the header is now a **lookup** — it states the name, keeps the "never use the Vitana ID handle as address" clause, ships **no** greeting exemplar to parrot, and explicitly defers greet/don't-greet, name/no-name, and wording to the turn's opening directive and greeting rules. Name resolution, wiring, and the null/empty branches are unchanged. `authoritative-user-name.test.ts` gained a VTID-03475 regression block asserting the header carries no `Hi/Hallo/Guten Tag <Name>` exemplar and no imperative "greet them". Full local suite: 615/615 suites, 12038/12051 tests passing (7 skipped, 6 todo — pre-existing). | VTID-03475 |
| 2026-08-01 | **ORB voice: WebSocket is now the browser's default transport, and the WS session start stopped being a second implementation.** The widget's default flips from SSE-down + one authenticated POST per 64ms audio chunk (~15.6 req/s while the user speaks) to the single bidirectional socket at `/api/v1/orb/live/ws`. The blocker was not the flip — it was that the WS `start` frame ran a fork of session start dating to VTID-01222, which had never received wake-brief selection (VTID-03079/03101), journey guidance (VTID-03300), guided-topic narration (VTID-03290), fast-start wake deferral, the voice quota gate (VTID-03107), the `AUTH_TOKEN_INVALID` re-auth signal, or reconnect continuity (VTID-02020's `transcript_history`/`reconnect_stage`/`conversation_id`). Six features added to the HTTP path over ~7 months, silently absent from the WS one — flipping the default first would have regressed the opener for every logged-in session. New `orb/live/session/ws-start-adapter.ts` runs the WS start through the same `handleLiveSessionStart` the HTTP path uses (it touches only `req.identity`/`req.headers`/`req.get()`/`req.body`/`res.status().json()`), deleting ~290 lines of fork. **Consequence to know:** the live session id and the `ws-<uuid>` socket id are now different strings — `wsClientSessions` is keyed by the socket, `liveSessions` by the live id, and `cleanupWsSession` was leaking the live session by deleting under the wrong key. Safety on the flip: automatic one-shot fallback to SSE when a WS start fails for a *transport* reason (latched per tab in sessionStorage, not localStorage — a network that blocks upgrades is where the user is, not a verdict on their browser), server rejections deliberately NOT retried on SSE, and a new unauthenticated `GET /api/v1/orb/live/transport` backed by `FEATURE_ORB_WS_TRANSPORT_ENV` so the default can be revoked without redeploying a static asset. | VTID-03471 |
| 2026-08-01 | Watcher `writeSteps` reported a hard `0` on every successful write: `count: 'exact'` does not compose with `ignoreDuplicates` (`ON CONFLICT DO NOTHING`), so PostgREST returned `count: null` and `count ?? 0` reported nothing written. Measured on staging: 536 rows genuinely in `watcher_steps`, `last_written` stuck at `0`, `last_error` null. Not cosmetic — `last_written` exists precisely so "this source scans every tick and writes nothing" is visible (the signature of a broken normalizer), so the one diagnostic built to catch that failure was blind to exactly it. Fixed by selecting the inserted rows instead of asking for a count. | VTID-03473 |
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
| 2026-07-23 | Added §13c: Vitanaland Commerce long-term vision — self-service merchant onboarding (any existing or future business connects to Discover directly, Shopify-like ease, not hand-written migrations per merchant) as a standing framework for evaluating future Discover/Commerce work. Recorded per explicit request during the DoctorBox per-product-deep-link/new-products round (VTID-02000). | BOOTSTRAP-COMMERCE-VISION |
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
