# Autonomous Execution Review - 2026-02-13

## Purpose

Code-level analysis of Vitana's autonomous execution pipeline, comparing external
advisory (ChatGPT) against actual implementation state. Provides grounded
recommendations for making autonomous execution reliable and enabling
self-improvement.

---

## 1. External Claims vs. Ground Truth

| Claim | Verdict | Evidence |
|---|---|---|
| Supabase + Prisma stable | **CONFIRMED** | `prisma/schema.prisma` has 3 clean models, migrations run in CI |
| Gateway live on Cloud Run | **CONFIRMED** | 78+ route files, Dockerfile, Express app |
| GitHub webhooks streaming into OASIS | **CONFIRMED** | `webhooks.ts` (309 lines), HMAC verification, VTID extraction |
| Crew Template v1.2 frozen | **PARTIALLY FALSE** | `crew.yaml` exists but is not versioned as 1.2. Role→model mapping contradicts `router.py` |
| Constitution in DB | **FALSE** | No constitution document or table. Governance via `autonomy_guardrails.yaml` + VTID control |
| Memory-Indexer deployed | **TRUE BUT DEPRECATED** | Flask service (1082 lines total) using Mem0+Qdrant. Deprecated per VTID-01184 |
| Conductor deployed | **EFFECTIVELY FALSE** | 17-line stub. Health endpoint + `POST /crew → {status: success}`. Real routing in LLM Router |
| VTID governance active | **CONFIRMED** | `VtidLedger` table, OASIS projector sync, 300+ event types, worker-orchestrator gates |
| Execution pipeline instability | **NUANCED** | Core pipeline (worker-runner→orchestrator) is solid. Instability in autopilot layer and config drift |
| Command Hub ↔ Gateway fragile | **LIKELY TRUE** | No dedicated Command Hub service. MCP tools exist but integration path underspecified |
| Autonomous end-to-end not reliable | **TRUE** | But root cause differs from external diagnosis |

---

## 2. Three Root Causes of Execution Failure

### 2.1 Two Disconnected Execution Planes

**Plane A** — Worker-runner (`services/worker-runner/src/execution-service.ts`):
- Calls Vertex AI (Gemini-2.5-pro) directly
- Hardcoded model string
- Reports to OASIS

**Plane B** — Conductor/LLM Router (`services/agents/conductor/llm-router/router.py`):
- Routes by role (Planner→Claude, Worker→Gemini Flash, Validator→Claude)
- Has fallback logic and telemetry
- Reports to OASIS

**These don't interact.** The worker-runner doesn't call the LLM Router. The Conductor
doesn't dispatch to the worker-runner. They are parallel systems.

### 2.2 Declarative Contracts Without Runtime Enforcement

`autonomy_guardrails.yaml` declares:
```yaml
planner_contract:
  must_include: [rollback_plan, idempotency_key, risk_level, approvals_needed?]
worker_contract:
  must_include: [commands, dry_run, pr_required, rollback_commands]
```

**Nothing validates** that LLM outputs conform to these contracts. The worker-runner
sends a prompt, gets freeform text back, and acts on it. No schema gate exists
between LLM response and action execution.

### 2.3 No Feedback Loop

When a VTID fails:
1. Status set to `failed` in ledger
2. OASIS event emitted
3. Nothing else happens

No failure analysis. No pattern extraction. No prompt improvement. No routing
adjustment. The system has observability but no introspection.

---

## 3. Config Drift: Three Sources of Truth

| Source | Planner Model | Worker Model | Validator Model |
|---|---|---|---|
| `crew_template/crew.yaml` | gemini | claude | chatgpt |
| `conductor/llm-router/router.py` | claude-3-5-sonnet | gemini-1.5-flash | claude-3-5-sonnet |
| `worker-runner/execution-service.ts` | N/A (not used) | gemini-2.5-pro (hardcoded) | N/A (not used) |

Three files, three different answers to "who does what." This must be resolved.

---

## 4. Recommendations

### Phase 1: Unify Execution Plane

1. **Decide: worker-runner IS the conductor, or wire them together.**
   The 17-line Conductor stub (`services/agents/conductor/main.py`) should either be
   deleted or promoted into a real orchestrator that dispatches to worker-runners.
   Currently the worker-runner does its own orchestration.

2. **Integrate LLM Router into worker-runner.**
   Port the Router's role-based dispatch and fallback logic into the worker-runner's
   execution service, or expose it as an HTTP service the worker-runner calls.
   Eliminate the hardcoded model string in `execution-service.ts`.

3. **Single model-assignment config.**
   Make `crew.yaml` the sole source of truth for role→model mappings.
   All runtime code reads from it. Delete hardcoded model strings.

### Phase 2: Enforce Contracts at Runtime

4. **JSON Schema validation on LLM outputs.**
   Before the worker-runner acts on an LLM response, validate it against the
   contract schema from `autonomy_guardrails.yaml`. Reject non-conforming responses
   and re-prompt with the validation error.

5. **Database-level state transition constraints.**
   Add a Postgres trigger or function that enforces valid VTID status transitions:
   `pending→active→complete/failed/blocked`, `blocked→active`. Reject invalid
   transitions at the DB level, not just in application code.

6. **Close the event→execution loop.**
   The OASIS projector syncs events→ledger. Add reverse: ledger state changes
   trigger the worker-runner via its push endpoint (VTID-01206). This creates:
   task created → projector detects → triggers worker → worker executes →
   projector updates ledger.

### Phase 3: Self-Improvement Loop

7. **Failure analyzer service.**
   Query OASIS events where status=failed/error. Group by VTID pattern, error type,
   model, domain. Emit daily insights to a `system_insights` table. Simplest form
   of self-improvement: knowing what keeps failing.

8. **Prompt versioning.**
   Store prompt templates as versioned artifacts. Record which version was used per
   VTID execution. Track success/failure rates per prompt version per domain.
   Auto-select best-performing version.

9. **Retry with mutation.**
   On failure: check if retryable → re-prompt with validation error appended →
   cap at 3 retries (enforce `max_iterations_per_rid` from guardrails) →
   escalate to human on exhaustion.

10. **Performance metrics feedback.**
    Record per-VTID: time-to-claim, time-to-execute, tokens used, cost,
    success/fail. Use data to tune polling intervals, model selection, timeouts.

### Phase 4: Sustainability

11. **Consolidate memory to pgvector.**
    Mem0+Qdrant is deprecated (VTID-01184). Migrate remaining usage to Supabase
    pgvector. Two memory systems = two sources of truth = drift.

12. **System self-awareness endpoint.**
    Let the planner query system health before task decomposition: worker health,
    memory service status, current failure rate, active VTIDs. Context-aware
    planning based on real system state.

---

## 5. What NOT to Do

- Do not add another orchestration framework
- Do not rebuild Supabase/OASIS/Gateway
- Do not switch clouds or providers
- Do not add more LLM providers until the existing three configs agree
- Do not design for "general AGI autonomy" — design for deterministic task execution
  with intelligent modules

---

## 6. Priority Order

| Priority | Action | Why |
|---|---|---|
| P0 | Resolve config drift (crew.yaml vs router.py vs execution-service.ts) | Without this, role→model routing is undefined |
| P0 | Wire LLM Router into worker-runner OR delete Conductor stub | Two disconnected planes = unpredictable behavior |
| P1 | Add JSON Schema validation on LLM outputs | Contracts exist but aren't enforced |
| P1 | Add DB-level state transition constraints | Prevent invalid VTID state corruption |
| P2 | Close projector→worker push loop | Enables true autonomous end-to-end |
| P2 | Build failure analyzer | Foundation for self-improvement |
| P3 | Prompt versioning + performance tracking | Data-driven improvement |
| P3 | Consolidate memory to pgvector | Eliminate deprecated dependency |
