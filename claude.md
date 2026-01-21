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

## CHANGE LOG

| Date | Change | VTID |
|------|--------|------|
| 2026-01-21 | Added ALWAYS/NEVER/IF-THEN core rules | VTID-01200 |
| 2026-01-21 | Initial creation with technical reference | VTID-01200 |
