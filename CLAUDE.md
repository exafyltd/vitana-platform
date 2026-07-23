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
   the AWS parallel/DR environment for the `gateway` service, sanctioned
   under **VTID-03398** — see §1b. GCP remains canonical production; AWS
   is additive DR capacity for gateway only, not a new canonical target.)
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

1. **IF** VTID does not exist → **THEN STOP.**
2. **IF** `spec_status ≠ approved` → **THEN DO NOT EXECUTE.**
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

## 1b. AWS PRODUCTION (DR) — GATEWAY (VTID-03398)

GCP (`lovable-vitana-vers1`) remains the **canonical** production for every
service. AWS hosts a **parallel/DR production for the `gateway` service
only** — additive capacity, not a migration, and not a general "use AWS
too" precedent for other services. Do not extend this pattern to another
service without its own VTID.

| Item | Value |
|---|---|
| AWS account / region | `472838866351` / `eu-central-1` |
| ECS cluster | `Vitana-ECS-Cluster` (shared with AWS staging) |
| ECS service (AWS-DR prod) | `vitana-gateway-awsdr` — **distinct from** `vitana-gateway` (AWS staging) |
| Task definition family | `vitana-gateway-awsdr` |
| Public URL | `https://dr-gateway.vitanaland.com` |
| Target group | `vitana-tg-gateway-awsdr` (on the existing `vitana-alb-prod` ALB) |
| Database | RDS Aurora PostgreSQL `vitana-aurora-prod` (writer/reader), same Supabase project as GCP prod (`inmkhvwdcuyhnxkgfvsb`) |
| Redis | ElastiCache `vitana-redis-prod` |
| Deploy workflow | `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` — **`workflow_dispatch`-only, required `reason`, never on push** |

**Full build record, exact commands, and pre-existing-state findings:**
`docs/AWS-PRODUCTION-BUILD-LOG.md`.

### Hard rules specific to AWS-DR prod

- **Never** deploy to AWS-DR prod on push — `AWS-PROD-DEPLOY-GATEWAY.yml`
  has no `on: push` trigger. It mirrors the GCP staging-first model
  (§16): AWS staging (`vitana-gateway`) auto-deploys on push; AWS prod
  (`vitana-gateway-awsdr`) is a deliberate manual dispatch with a
  recorded reason, same spirit as the GCP PUBLISH button /
  `publish-to-prod.sh` escape hatch.
- **Never** confuse `vitana-gateway` (AWS staging) with
  `vitana-gateway-awsdr` (AWS DR prod) — same ECS cluster, similarly
  named. The `vitana-alb-prod` ALB's target group named
  `vitana-tg-gateway-prod` is a **pre-existing naming leftover that
  actually serves staging traffic**, not AWS-DR prod — verify via
  `/api/v1/admin/health`'s `env` field before trusting a resource name.
- **IF** adding another host-header listener rule to `vitana-alb-prod` →
  **THEN** give it priority < 10 — the ALB's existing path-based rules
  (`/api/*`, `/ws/*` at priority 10) match before higher-numbered
  host-header rules regardless of `Host`, and will silently route to
  staging otherwise (see the build log's "ALB listener-rule priority"
  section for how this bit the initial build).
- **Never** extend AWS-DR to `oasis-operator`, `oasis-projector`,
  `worker-runner`, `vitana-verification-engine`, or the frontend without
  a new VTID — gateway-only is the deliberate first slice.
- GitHub OIDC federation (no static AWS keys) is required for the prod
  deploy role, mirroring `scripts/aws/README.md`'s pattern — **never**
  add a static-key IAM user for AWS-DR prod deploys the way AWS staging
  did (`claude-staging-validation`; a known shortcut, not to be repeated).

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
- **Not yet supported:** vision (`image`/`images`) and tool calling
  (`tools`/`forceTool`) — the adapter returns an explicit error for these
  rather than silently dropping them or mis-serializing the request.
- **Implementation:** `services/gateway/src/providers/bedrock.ts`
  (`invokeBedrock()`) does the actual `BedrockRuntimeClient.send()` call;
  `bedrockAdapter` in `llm-router.ts` adapts it to the router's
  `ProviderAdapter` interface. Provider/model/latency logging comes for
  free via the router's existing `startLLMCall`/`completeLLMCall`/
  `failLLMCall` telemetry — no Bedrock-specific logging code needed.

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
| 2026-07-23 | Stood up AWS Production (DR) for the gateway service only — parallel to canonical GCP prod, not a migration: ECS service `vitana-gateway-awsdr`, dedicated target group + host-header ALB rule (`dr-gateway.vitanaland.com`), autoscaling + CloudWatch alarms, `AWS-PROD-DEPLOY-GATEWAY.yml` (dispatch-only, required reason, never on push). Added §1b governance section + Never-rule exception. GitHub OIDC deploy-role wiring left for an operator with IAM admin rights (session's AWS IAM user has zero IAM write permissions) — see `docs/AWS-PRODUCTION-BUILD-LOG.md`. | VTID-03398 |
| 2026-07-21 | Public "Business" tab: profile visitors can now see another user's active product recommendations (storefront card, buy-through with commission attributed to the profile owner via the existing VTID-02950 `?rec=`/`rec_id` flow). New public endpoint `GET /api/v1/discover/recommendations/:vitanaId` (`discover-recommendations-public.ts`), auth-required (any logged-in viewer, not owner-only), never returns click/conversion/commission fields. No formal VTID existed for this extension; tracked under this BOOTSTRAP tag pending one. | BOOTSTRAP-PUBLIC-BUSINESS-PROFILE |
| 2026-07-13 | Integrated lycorp-jp/sim-use device-testing layer: `e2e/mobile-sim/` driver + smoke flow (iOS Simulator / Android), `MOBILE-DEVICE-E2E.yml` macOS-runner workflow, vendored sim-use agent skill + `vitana-mobile-testing` glue skill, `docs/MOBILE_DEVICE_TESTING.md` | BOOTSTRAP-SIM-USE-DEVICE-TESTING |
| 2026-06-04 | Staging-first cutover (time-gated, effective Mon 8 Jun 2026 10:00 Europe/Berlin): added a `cutover_gate` job to every auto-to-prod workflow (`AUTO-DEPLOY`, `DEPLOY-ORB-AGENT`, `DEPLOY-AUTOPILOT-JOB`, `VTID-02409-BOOTSTRAP`) that freezes the push path post-cutover while leaving manual dispatch open; added manual escape hatch `scripts/deploy/publish-to-prod.sh`; rewrote §15/§16 + IF-THEN CI/CD rules. Before cutover all paths still reach prod; after, auto = staging, prod = PUBLISH button / manual exception. Frontend (`vitana-v1`) gated in parallel. | BOOTSTRAP-STAGING-FIRST-CUTOVER |
| 2026-04-14 | Replaced broad visual verification with targeted protocol: screenshot what you changed, interact with it, verify it works | VTID-01917 |
| 2026-03-19 | Added CI/CD deployment pipeline critical lessons (Auto Deploy ≠ actual deploy) | BOOTSTRAP-OPERATOR-NAV-FIX |
| 2026-02-13 | Added Deployment Verification Protocol section + rules | VTID-01228 |
| 2026-02-03 | Added Memory & Intelligence Architecture section | VTID-01225 |
| 2026-01-21 | Added ALWAYS/NEVER/IF-THEN core rules | VTID-01200 |
| 2026-01-21 | Initial creation with technical reference | VTID-01200 |
