# CLAUDE.md - Vitana Platform Development Guide
**CANONICAL REFERENCE - Last Updated: 2026-05-11**

This file contains critical information for AI assistants working on the Vitana platform.
**READ THIS BEFORE MAKING ANY CHANGES.**

> Volatile, fast-moving notes (recent incidents, in-flight projects, shipped feature pointers)
> live in `~/.claude/projects/-home-dstev/memory/MEMORY.md`. This file is the **stable rule set** —
> conventions, invariants, and protocols that change slowly.

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
24. **Always run `npm run build` (not `npm run typecheck`)** before pushing gateway / TypeScript service code. `tsc --noEmit` (typecheck) silently misses errors that `tsc` build mode catches.
25. **Always work in a git worktree** on `vitana-platform`. Multiple Claude sessions run in parallel against this repo; committing directly to `main` from the shared checkout creates collisions.
26. **Always pre-allocate a VTID** via `POST /api/v1/vtid/allocate` before opening a PR that touches deployable services (gateway, worker-runner, orb-agent, etc.). EXEC-DEPLOY blocks merges whose commit-SHA VTID is absent from `vtid_ledger`. SQL-only PRs are exempt.
27. **Always front the gateway via `https://gateway.vitanaland.com`** in CI/CD scripts, governance probes, and frontend env. The Cloud Run `*.run.app` URL still works but is being phased out behind Cloudflare.

### Database & Memory

21. **Always use Supabase as the persistent data store.**
22. **Always enforce tenant isolation (RLS).**
23. **Always use snake_case table names.**
24. **Always route DB mutations through Gateway APIs.**
25. **Always treat `memory_items` as canonical infinite memory.**
26. **Always use pgvector for semantic memory.**
27. **Always scope memory by tenant + role.**
28. **Always retrieve memory selectively (relevance-based).**
29. **Always log memory debug snapshots in dev.**

### Frontend & UX

31. **Always preserve Command Hub module/tab structure and order** (defined by `NAVIGATION_CONFIG` in `app.js`; regenerated into `navigation-config.js`).
32. **Always treat ORB as voice-first, multimodal.**
33. **Always comply with CSP** (no inline scripts/styles).
34. **Always bundle JS locally** (no CDN script loads).
35. **Always respect fixed layout regions.**
36. **Always use Markdown specs** (no Figma).
37. **Always maintain WCAG 2.2 AA compliance.**
38. **Always use Command Hub design-system tokens** (CSS custom properties) — no hex literals in new screens.

---

## ❌ NEVER RULES

Claude must **never** do the following:

### Architecture & Logic

1. **Never invent new projects, environments, or services.**
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
41. **Never reintroduce `LOVABLE_SUPABASE_*` env vars.** Events use platform `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE` as of 2026-04-17.
42. **Never resurrect `APPLY-MIGRATIONS.yml`.** It was deleted 2026-04-11 because it silently swallowed `ROLLBACK`. Use `RUN-MIGRATION.yml` (one file at a time).
43. **Never edit the legacy frontend in `temp_vitana_v1/`.** That directory is gitignored stale content; the real frontend lives in a separate repo `exafyltd/vitana-v1` (working copy at `/home/dstev/vitana-v1`).
44. **Never commit gateway code that builds clean under `tsc --noEmit` but fails `tsc` build mode.** Always `npm run build` before push.
45. **Never claim a fix is verified using `e2e-test@vitana.dev`** when the user reports a real-user issue. Mint the affected user's session via admin `generate_link` and exercise the same endpoint the UI calls.
46. **Never return `degraded:true` / `partial:true` / `warning:` in voice-tool responses.** Gemini Live reads them as failure and apologizes even when `ok:true`. Keep telemetry server-side; tool JSON must match full-success shape.

### Frontend & UX

21. **Never reorder or remove existing Command Hub modules/tabs without an approved spec.**
22. **Never introduce inline JS or CSS.**
23. **Never load JS from CDNs.**
24. **Never invent UI screens.** Add them via the navigation catalog regen pipeline.
25. **Never break layout invariants.**
26. **Never ship experimental UI to prod** without a feature flag.
27. **Never violate CSP, even temporarily.**
28. **Never hex-code colors in new screens.** Use design-system tokens.

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

16. **IF** EXEC-DEPLOY completes → **THEN curl the most-changed endpoint at `https://gateway.vitanaland.com` and confirm JSON response (not HTML 404). See Section 15 for the full protocol.**
17. **IF** curl returns `text/html` content-type → **THEN the route does NOT exist on the deployed revision** — wrong code shipped or build failed silently.
18. **IF** ever tempted to run `gcloud builds submit` / `gcloud run deploy` by hand → **THEN STOP.** That bypasses governance (NEVER rule 2). Dispatch `EXEC-DEPLOY.yml` instead.

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

### CI/CD Pipeline (CRITICAL - Added 2026-03-19)

21. **IF** Auto Deploy shows "success" → **THEN check EXEC-DEPLOY runs to confirm actual deployment was dispatched. Auto Deploy success does NOT mean code was deployed.**
22. **IF** commit message has no VTID → **THEN Auto Deploy will NOT dispatch EXEC-DEPLOY. Manually trigger EXEC-DEPLOY with BOOTSTRAP prefix.**
23. **IF** merging a PR to main → **THEN ALWAYS verify EXEC-DEPLOY is running after merge. Do NOT assume Auto Deploy handled it.**
24. **IF** EXEC-DEPLOY was not dispatched → **THEN manually dispatch it via GitHub API with `BOOTSTRAP-<description>` as the VTID.**
25. **IF** making frontend CSS/JS changes → **THEN bump the `?v=` cache-busting parameter in index.html AND verify EXEC-DEPLOY completes.**
26. **IF** EXEC-DEPLOY shows "failure" on the Terminal Gate step → **THEN check Service URL + Smoke Tests logs first. Often the deploy succeeded but OASIS bookkeeping POST got UNAUTHENTICATED — do NOT redeploy automatically.**
27. **IF** `gh run view --json status` shows `in_progress` 30-90s after every step is green → **THEN drop to job-step inspection (`gh run view --log`) before telling the user to wait again. GH Actions run-status lags step-status.**
28. **IF** a PR touches deployable code (gateway / worker-runner / orb-agent / openclaw-bridge / oasis-*) → **THEN pre-allocate a VTID via `POST /api/v1/vtid/allocate` and include it in the merge commit message. SQL-only PRs are exempt.**

### Frontend & Repo Layout (Added 2026-05-11)

31. **IF** the change is to the community frontend (vitanaland.com / mobile WebView) → **THEN open the PR against `exafyltd/vitana-v1` (NOT `vitana-platform`). The frontend is a separate repo.**
32. **IF** the change is to Command Hub UI → **THEN edit `services/gateway/src/frontend/command-hub/` in `vitana-platform`. Command Hub is gateway-served, NOT in vitana-v1.**
33. **IF** working on a phone / Appilix WebView session → **THEN treat the user role as `community` regardless of DB role. Guard every role-reading path on both frontend and gateway.**
34. **IF** editing `firebase.ts` or `pushNotifications.ts` in vitana-v1 → **THEN verify imports compile before commit. A broken import here crashes the entire app after login.**

### Voice & Tools (Added 2026-05-11)

35. **IF** adding a new ORB voice tool → **THEN add it via the shared `orb-tool-dispatcher` (services/gateway/src/services/orb-tools/), NOT inline in `orb-live.ts`. The lift-not-duplicate scanner enforces this.**
36. **IF** a voice-tool response would set `degraded:true` / `partial:true` / `warning:` → **THEN keep telemetry server-side instead. Gemini Live treats those fields as failure even with `ok:true`.**
37. **IF** investigating ORB voice symptoms on iOS → **THEN production orb is gateway-served `services/gateway/src/frontend/command-hub/orb-widget.js`. The vitana-v1 React orb chain (`VitanaAudioOverlay` → `useOrbVoiceClient` → `instantGreeting` → `iosAudioUnlock`) is DEAD CODE — Vite tree-shakes it.**

### Database Migrations (Added 2026-05-11)

38. **IF** applying a Supabase migration → **THEN use the `RUN-MIGRATION.yml` workflow (one file at a time). `APPLY-MIGRATIONS.yml` was deleted 2026-04-11 — do not resurrect.**
39. **IF** a `RUN-MIGRATION.yml` run says "applied successfully" → **THEN grep the logs for `ROLLBACK` and verify schema after every run. `psql -f` does NOT `ON_ERROR_STOP`, so SQL errors silently roll back while the workflow reports success.**
40. **IF** writing direct SQL against `oasis_events` → **THEN use the `topic` column (no `type` column exists; the TS `emitOasisEvent()` helper masks this). No `tenant_id` column either — don't propose tenant-scoped queries/indexes.**

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

26. **IF** routing an LLM call → **THEN go through the gateway LLM router** (`services/gateway/src/services/llm-router*.ts`). It owns provider/model selection across Vertex, Gemini API, DeepSeek, and the `claude_subscription` worker queue.
27. **IF** a model fallback occurs → **THEN log provider + model + reason explicitly** to OASIS. Silent fallback is forbidden.
28. **IF** TTS is used → **THEN specify `model_name` explicitly.** Operator-tunable `speakingRate` lives in `system_config['tts.speaking_rate']`.
29. **IF** routing through `claude_subscription` → **THEN the request is queued to `autopilot-worker` which runs `claude -p` against the Pro/Max plan.** Do not call Anthropic API keys from the gateway.
30. **IF** a preview model is used (e.g. `gemini-3.1-pro-preview`) → **THEN it must route through AI Studio, not Vertex.** Vertex 404s on preview model IDs (VTID-02689/02690).

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

## 2. SERVICES ARCHITECTURE

### Deployable Services (Cloud Run)
| Service | Source Path | Cloud Run Name | Runtime | Purpose |
|---------|-------------|----------------|---------|---------|
| Gateway | `services/gateway/` | `gateway` | Node/TS | Main API, Command Hub frontend, ORB Vertex Live |
| OASIS Operator | `services/oasis-operator/` | `oasis-operator` | Node/TS | OASIS state machine |
| OASIS Projector | `services/oasis-projector/` | `oasis-projector` | Node/TS | OASIS read-model projection |
| Verification Engine | `services/agents/vitana-orchestrator/` | `vitana-verification-engine` | Node/TS | Spec validation pipeline |
| Worker Runner | `services/worker-runner/` | `worker-runner` | Node/TS | VTID worker execution plane |
| ORB Agent | `services/agents/orb-agent/` | `orb-agent` | **Python** | LiveKit voice agent (parity track with Vertex Live in gateway) |
| OpenClaw Bridge | `services/openclaw-bridge/` | `openclaw-bridge` | Node/TS | Bridges OpenClaw skills + heartbeat into OASIS governance |
| MCP Gateway | `services/mcp-gateway/` | `mcp-gateway` | Node/TS | MCP protocol gateway |
| OASIS | `services/oasis/` | `oasis` | Node/TS | OASIS core API |

### Non-Deployable Services (Libraries / In-Process / Scaffold)
- `services/agents/cognee-extractor/` — entity-extraction worker library
- `services/agents/conductor/` — Python LLM router (Gemini/Claude/DeepSeek)
- `services/agents/memory-indexer/` — pgvector backfill / embedding worker
- `services/agents/validator-core/` — validator primitives
- `services/agents/workforce/` — agent registry helpers
- `services/agents/crewai-gcp/` — CrewAI experiment harness
- `services/agents/shared/` — shared agent code
- `services/autopilot-worker/` — Dev Autopilot LLM worker (runs `claude -p` against the Pro/Max subscription, off the gateway's pay-per-token key)
- `services/mcp/` — MCP protocol primitives
- `services/deploy-watcher/` — Deploy watcher
- `services/validators/` — Validators
- `services/vaea/` — VTID-02401 Vitana Autonomous Economic Actor (Phase 0 scaffold; `deployable=false` until Phase 1)

### Cloudflare Workers (separate deploy)
Source: `cloudflare/`. Workers:
- `cloudflare/email-intake-worker/` — inbound email → gateway intake
- `cloudflare/vitanaland-og-proxy/` — OG-image proxy for shared profile/intent links

Deployed via `.github/workflows/DEPLOY-CLOUDFLARE-WORKERS.yml`.

### Service Path Map
Canonical mapping: `config/service-path-map.json` (drives AUTO-DEPLOY service detection)

---

## 3. DATABASE (SUPABASE)

### Critical Rules
1. **PostgreSQL tables MUST use `snake_case`** (vtid_ledger, oasis_events)
2. **TypeScript code MUST reference EXACT table names**
3. **Inspect the live schema** via Supabase MCP `list_tables` / `execute_sql` before creating any table. (`DATABASE_SCHEMA.md` exists but is not actively maintained — treat as historical reference, not source of truth.)

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
| `AUTO-DEPLOY.yml` | Detects merges to `main`, parses VTID + service from commit, dispatches EXEC-DEPLOY |
| `EXEC-DEPLOY.yml` | Canonical deployment (VTID governance, smoke tests, OASIS bookkeeping) |
| `RUN-MIGRATION.yml` | Manual Supabase migration runner (one file at a time) |
| `DEPLOY-ORB-AGENT.yml` | LiveKit Python voice agent deploy |
| `DEPLOY-CLOUDFLARE-WORKERS.yml` | Email intake + OG proxy workers |
| `DEPLOY-AUTOPILOT-JOB.yml` | Cloud Run Job runtime for Dev Autopilot executor (VTID-02703) |
| `DEV-AUTOPILOT.yml` | Dev Autopilot polling + LLM execution loop |
| `DEV-AUTOPILOT-IMPACT.yml` | Autopilot blast-radius analyzer |
| `E2E-ORB-MONITOR.yml` | Scheduled ORB voice smoke test |
| `E2E-TEST-RUN.yml` | E2E test runner |
| `COMMAND-HUB-GUARDRAILS.yml` | Frontend guardrails (CSP, sidebar invariants) |
| `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` | Block frontend edits in the wrong repo / path |
| `ORB-TOOLS-LIFT-SCANNER.yml` | Enforces voice-tool lift-not-duplicate (shared dispatcher) |
| `PHASE-2B-DOC-GATE.yml` | Doc-gate for governance documentation |
| `PHASE-2B-NAMING-ENFORCEMENT.yml` | snake_case enforcement |
| `CICDL-GATEWAY-CI.yml` | Gateway CI (lint, typecheck, build, test) |
| `CICDL-CORE-LINT-SERVICES.yml` | Cross-service lint |
| `CICDL-CORE-OPENAPI-ENFORCE.yml` | OpenAPI schema enforcement |
| `MCP-GATEWAY-CI.yml` | MCP Gateway CI |
| `OASIS-PERSISTENCE.yml` | OASIS persistence backfill |
| `MARKETPLACE-SYNC-CRON.yml` | Marketplace sync schedule |
| `REGEN-SCREENS-CATALOG.yml` | Regenerate navigator screens catalog from vitana-v1 manifest |
| `REUSABLE-NOTIFY.yml` | Reusable notify-on-fail callable workflow |

### Retired

- `APPLY-MIGRATIONS.yml` — deleted 2026-04-11 (silently swallowed ROLLBACK).

### Deployment Requirements
1. VTID must exist in `vtid_ledger` before deploy (VTID-0542). Pre-allocate via `POST /api/v1/vtid/allocate` for code-touching PRs.
2. Governance evaluation must pass (VTID-0416).
3. All deploys go through the governed CI pipeline.
4. Smoke tests + Terminal Gate must pass against `https://gateway.vitanaland.com` (Cloudflare-fronted).

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

**Do NOT run `gcloud builds submit` / `gcloud run deploy` directly.** That bypasses VTID governance, smoke tests, and OASIS bookkeeping (NEVER rule 2). The canonical path is:

1. Pre-allocate a VTID for the change: `POST /api/v1/vtid/allocate`
2. Open + merge a PR with that VTID in the commit message
3. `AUTO-DEPLOY.yml` parses the VTID and dispatches `EXEC-DEPLOY.yml`
4. If `AUTO-DEPLOY` skips (no VTID found), manually dispatch `EXEC-DEPLOY.yml` via the GitHub API or CLI with `BOOTSTRAP-<description>` as the VTID

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

Deployments have repeatedly failed because the wrong branch was merged or the build silently dropped a route. This protocol prevents that.

### Pre-Deploy Verification (BEFORE merging the PR that triggers EXEC-DEPLOY)

1. **Verify source code has the expected changes:**
   ```bash
   # Example: confirm a new route exists on the branch being merged
   grep -r "sessions" services/gateway/src/routes/live.ts | head -5
   ```
2. **Verify the build succeeds (not just typecheck):**
   ```bash
   cd services/<service> && npm run build
   ```
   `tsc --noEmit` is NOT sufficient — it misses errors that `tsc` build mode catches.

### Post-Deploy Verification (AFTER EXEC-DEPLOY reports success)

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

## 16. CI/CD DEPLOYMENT PIPELINE — CRITICAL LESSONS (2026-03-19)

**This section exists because of repeated deployment failures. READ CAREFULLY.**

### AUTO-DEPLOY Does NOT Mean Code Is Deployed

The `AUTO-DEPLOY.yml` workflow triggers on pushes to `main` under `services/gateway/**`, but it **ONLY dispatches `EXEC-DEPLOY.yml` if a VTID is found in the commit message**. If no VTID is found, the workflow exits with `success` status but **NO actual Cloud Run deployment happens**.

**This is deceptive**: The GitHub Actions UI shows Auto Deploy as "success" even when nothing was deployed.

### Post-Merge Deployment Checklist

After merging a deployable PR:

1. **Verify EXEC-DEPLOY was dispatched** by AUTO-DEPLOY:
   ```bash
   gh run list --workflow=EXEC-DEPLOY.yml --limit=3
   ```
   If the latest run is NOT `in_progress`, AUTO-DEPLOY did NOT dispatch.

2. **If not dispatched, manually trigger** (the merge commit lacked a recognized VTID):
   ```bash
   gh workflow run EXEC-DEPLOY.yml \
     -f vtid=BOOTSTRAP-<description> \
     -f service=gateway \
     -f environment=dev \
     -f health_path=/alive \
     -f initiator=auto
   ```

3. **Wait for completion + verify** per Section 15.

### Why AUTO-DEPLOY May Silently Skip Deployment

AUTO-DEPLOY extracts VTIDs from commit messages using:
```
(DEV-[A-Z0-9]+-[0-9]{4}-[0-9]{4}|VTID-[0-9]{4,5}|BOOTSTRAP-[A-Z0-9\-]+)
```

If the commit message does NOT match this pattern, the workflow logs "No VTID found" and exits `success` — **without deploying**. This is why ALWAYS rule 26 (pre-allocate VTID) exists.

### CSS/JS Cache-Busting

The Gateway serves static files with `Cache-Control: no-cache, no-store, must-revalidate`, so browser caching is NOT an issue. However, `index.html` has `?v=` parameters on CSS/JS links. **Always bump these version strings** when making frontend changes to be safe:
```html
<link rel="stylesheet" href="/command-hub/styles.css?v=YYYYMMDD-HHMM" />
<script src="/command-hub/app.js?v=YYYYMMDD-HHMM"></script>
```

### GitHub Authentication

Use `gh` CLI (already authenticated as the operator) for all `vitana-platform` and `exafyltd/vitana-v1` operations. Per-repo PATs are stored outside the repo; never embed them in code, docs, or commit messages. The Lovable PAT is retired.

---

## 17. MULTI-REPO ARCHITECTURE (Updated 2026-05-11)

Vitana is split across **two GitHub repos**. Knowing which one owns a file is the single most common source of wasted edits.

### Repo Map

| Repo | Working Copy | Owns | Deploy Target |
|------|--------------|------|---------------|
| `exafyltd/vitana-platform` | `/home/dstev/vitana-platform` | Gateway, OASIS, agents, workers, Command Hub frontend, Supabase migrations, all Cloud Run services | Cloud Run (`us-central1`) via EXEC-DEPLOY |
| `exafyltd/vitana-v1` | `/home/dstev/vitana-v1` | Community frontend (vitanaland.com, mobile Appilix WebView) — React + Vite | Cloud Run `community-app` (auto-deploy on push to `main`) |

### Routing Rules

- **Community user-facing UI** (My Index, Diary, Autopilot popup, ORB overlay copy, profile, marketplace) → `exafyltd/vitana-v1`
- **Command Hub** (operator surface: `/command-hub/*`) → `vitana-platform`, served by the gateway from `services/gateway/src/frontend/command-hub/`
- **Voice / ORB pipeline backend** → `vitana-platform` (`services/gateway/src/routes/orb-live.ts` + `services/agents/orb-agent/`)
- **Voice / ORB frontend widget (production)** → `vitana-platform`, file `services/gateway/src/frontend/command-hub/orb-widget.js`. The vitana-v1 React orb chain is dead code (tree-shaken).
- **Supabase migrations** → `vitana-platform/supabase/migrations/`
- **Cloudflare workers** → `vitana-platform/cloudflare/`

### Retired

- **Lovable** (the no-code visual editor for the frontend) is fully retired as of 2026-04-10. Edit the React source in `vitana-v1` directly; PRs against `main`.
- **`temp_vitana_v1/`** inside `vitana-platform` is gitignored stale content — never edit.
- **Capacitor** (native wrapper) is retired; the mobile app is an Appilix WebView wrapper around vitanaland.com.

### Multi-Agent Safety on `vitana-platform`

Multiple Claude Code sessions run in parallel against this repo. To avoid stomping on each other:

1. **Always work in a git worktree** (`git worktree add ../vitana-platform-<task> -b <branch>`). Do not commit directly to `main` from the shared checkout.
2. **One PR per VTID.** Don't bundle unrelated changes — EXEC-DEPLOY can only attribute one VTID per merge SHA.
3. **Pre-allocate the VTID** before pushing: `POST /api/v1/vtid/allocate` returns the ID. Put it in the merge commit message.

### Frontend Verification URL

The community-app preview deploys to:
```
https://community-app-q74ibpv6ia-uc.a.run.app/
```
Every push to `main` of `exafyltd/vitana-v1` auto-deploys here in ~3 minutes. Always verify frontend fixes against this URL, not against `vitanaland.com` (which may still be on the old origin during the DNS migration).

---

## 18. DIAGNOSE BEFORE EDIT (Added 2026-05-11)

A pattern of repeated failures over March–May 2026 shows that almost all "stuck" symptoms have a structural root cause that is invisible until you check it. The following protocol is mandatory before opening a PR for a bug report:

### The 6-Step Triage

1. **Reproduce as the real user.** When the user reports something broken, mint *their* session via admin `generate_link` (Supabase Admin API) and call the same endpoint the UI calls. Never claim a fix is verified using the `e2e-test@vitana.dev` fixture — fixture sessions miss role-scoped failures, tenant-isolation bugs, and onboarding-state bugs.
2. **Exercise the actual screen, not just the API.** API success ≠ user success. Watch for `fetch()` calls in `app.js` that skip `buildContextHeaders()` and silently 401.
3. **Check observability first.** `get_logs` + `get_advisors` (Supabase MCP) and OASIS events (`oasis_events.topic`) before making changes. The topic ≠ a column called `type`; the TS helper masks this.
4. **Confirm which repo owns the file.** Mis-routed edits to the dead vitana-v1 React orb chain or to `temp_vitana_v1/` are a recurring waste.
5. **Identify which voice path is in play.** Two voice pipelines exist in parallel:
   - **Vertex Live** (gateway-owned, SSE+WebSocket, `orb-live.ts`)
   - **LiveKit + orb-agent** (Python agent in `services/agents/orb-agent/`, room-based)
   Per North Star, both must perform identically — but they fail differently. Establish which one the user is hitting before patching.
6. **Check memory for prior incidents.** Many symptoms have been "fixed" multiple times because they share a symptom across distinct failure modes (e.g., ORB iOS first-greeting silence has 5+ documented modes). Search `~/.claude/projects/-home-dstev/memory/` before drafting a fix.

### Anti-Pattern: Symptom-First Patching

When the LLM apologizes ("I had a problem"), the first instinct is to rewrite the prompt. That has been the wrong root cause every single time so far — the actual cause has been:
- Voice tool returning `degraded:true` / `partial:true` / `warning:`
- Reconnect-bucket prompt instructing apology on transparent reconnects
- Stale connector token surfacing as silent failure
- Identity inject missing on a reconnect path
- Gemini Live treating any non-success field shape as failure

Fix the upstream signal, not the prompt.

---

## 19. LiveKit ORB VOICE — PARITY TRACK (Added 2026-05-11)

The platform runs **two voice pipelines in parallel** and both are held to the same bar.

| Pipeline | Owner | Transport | Source of Truth |
|----------|-------|-----------|-----------------|
| Vertex Live | Gateway (`orb-live.ts`) | SSE + WebSocket | `orb-live.ts` constants — provider, model, tool catalog, prompt buckets |
| LiveKit | `orb-agent/` (Python) | LiveKit room | Phase 1.B Feature Parity Matrix |

### Rules

1. **LiveKit must mirror Vertex behavior** — same tool catalog, same identity-inject, same reconnect copy, same fallback ladder. Don't substitute generic implementations.
2. **Voice tools live in a shared dispatcher** — `services/gateway/src/services/orb-tools/`. Both pipelines call into it. The lift-not-duplicate scanner (`scripts/orb-tools-lift-scanner.mjs`) enforces this.
3. **Tool JSON response shape must match full-success.** No `degraded:true` / `partial:true` / `warning:` keys ever. Telemetry stays server-side.
4. **Voice operations surface in Command Hub** at `/command-hub/voice/*` (7 tabs: Orb LIVE, Providers & Voice, Awareness, Tool Catalog, Self-Healing, LiveKit Test Bench, Orb UI Monitor).

### Voice Tool Catalog Screen

`GET /api/v1/voice-tools/manifest` powers the Command Hub Voice Tool Catalog (DEV-COMHU-2700). Live status reflects which dispatcher tools are wired vs planned. Use design-system tokens, not hex.

---

## 20. SUPABASE MIGRATION WORKFLOW (Added 2026-05-11)

### Canonical Path

```
1. Write migration file:     supabase/migrations/YYYYMMDDHHMMSS_<vtid>_<slug>.sql
2. Open PR (SQL-only PRs do NOT need a code VTID — but include one in the filename for traceability)
3. Merge to main
4. Dispatch RUN-MIGRATION.yml manually with the migration filename
5. Verify: grep logs for ROLLBACK, then check schema with list_tables / execute_sql
```

### Critical Caveats

- **`psql -f` does NOT `ON_ERROR_STOP`.** SQL errors silently `ROLLBACK` while the workflow logs "applied successfully". Always check the logs.
- **PostgREST schema cache must be reloaded** — RUN-MIGRATION.yml does this via `NOTIFY pgrst, 'reload schema';` after each apply. If new RPC isn't visible, that step failed.
- **There is no `type` column on `oasis_events`** — use `topic`. The TS helper `emitOasisEvent()` masks this.
- **There is no `tenant_id` column on `oasis_events`** — don't propose tenant-scoped queries/indexes against it.
- **Two RPCs sound the same but only one exists:** `memory_semantic_search` (1536d, live) vs `semantic_memory_search` (768d, never migrated). Always use the former. Do NOT apply `20260221000000` — it would wipe the 1536d backfill.

### Retired

- `APPLY-MIGRATIONS.yml` was deleted 2026-04-11. Do not resurrect.

---

## CHANGE LOG

| Date | Change | VTID |
|------|--------|------|
| 2026-05-11 | Added Sections 17 (Multi-Repo Architecture), 18 (Diagnose Before Edit), 19 (LiveKit ORB Parity Track), 20 (Supabase Migration Workflow). Updated Section 2 services list (orb-agent / openclaw-bridge / worker-runner / autopilot-worker / vaea / Cloudflare workers). Added ALWAYS 24–27, NEVER 41–46, IF-THEN 26–40. Lovable retirement + Cloudflare migration + npm-run-build rule formalized. **Removed** stale rules: sidebar Start Stream (retired), "exactly 10 sidebar items" (now module/tab structure), hardcoded LLM routing (Gemini Pro=planner/Flash=worker — router now spans Vertex/Gemini/DeepSeek/claude_subscription), manual `gcloud builds submit` deploy commands (bypassed governance), `DATABASE_SCHEMA.md` upkeep rule (file 6 months stale), embedded PAT token references. Section 15/16 rewritten to point at EXEC-DEPLOY + `gateway.vitanaland.com` instead of direct Cloud Run URL. | n/a (doc refresh) |
| 2026-04-14 | Replaced broad visual verification with targeted protocol: screenshot what you changed, interact with it, verify it works | VTID-01917 |
| 2026-03-19 | Added CI/CD deployment pipeline critical lessons (Auto Deploy ≠ actual deploy) | BOOTSTRAP-OPERATOR-NAV-FIX |
| 2026-02-13 | Added Deployment Verification Protocol section + rules | VTID-01228 |
| 2026-02-03 | Added Memory & Intelligence Architecture section | VTID-01225 |
| 2026-01-21 | Added ALWAYS/NEVER/IF-THEN core rules | VTID-01200 |
| 2026-01-21 | Initial creation with technical reference | VTID-01200 |
