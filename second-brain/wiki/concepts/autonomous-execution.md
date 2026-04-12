# Autonomous Execution

> Vitana's autonomous architecture defines a three-layer agent model (AI Agents, Execution Sandbox, MCP Server Network) with governance guardrails, but an execution review revealed three root causes of failure: disconnected execution planes, unenforced contracts, and no feedback loop.

## Content

### Architecture (v1 Specification)

The Vitana Autonomous Workforce Architecture v1 defines three layers:

1. **AI Agents** -- Planner, Worker, and Validator roles with distinct responsibilities and output schemas. Each receives a shared input envelope containing task, role, recent events, and tool manifest.
2. **Vitana Execution Sandbox** -- Code runner, filesystem workspace, MCP client, and governance hooks. Responsible for actually executing agent outputs.
3. **MCP Server Network** -- Model Context Protocol servers for Supabase, Git, Perplexity, Google Drive, and OASIS.

### Agent Roles

| Role | Responsibility | Model (crew.yaml) | Model (router.py) | Model (worker-runner) |
|------|---------------|-------------------|-------------------|----------------------|
| Planner | Task decomposition, rollback plans, risk assessment | gemini | claude-3-5-sonnet | N/A |
| Worker | Command execution, dry-run, PR creation | claude | gemini-1.5-flash | gemini-2.5-pro (hardcoded) |
| Validator | Output verification, quality checks | chatgpt | claude-3-5-sonnet | N/A |

**Critical issue**: Three different config sources disagree on role-to-model mappings (see Config Drift below).

### OASIS Integration

The system integrates with OASIS (the event bus) for:
- VTID ledger management and lifecycle tracking
- Event emission for every autonomous action
- Task lifecycle (allocation -> execution -> PR -> validation -> merge -> deploy -> verify -> complete)
- Governance flag checking (EXECUTION_DISARMED, AUTOPILOT_LOOP_ENABLED)

### Governance Enforcement

Declared in `autonomy_guardrails.yaml`:
- **Planner contract**: Must include rollback_plan, idempotency_key, risk_level, approvals_needed
- **Worker contract**: Must include commands, dry_run, pr_required, rollback_commands
- **Hard rules**: Always enforced (e.g., never modify production directly)
- **Soft rules**: Enforced with exceptions (e.g., max iterations per task)
- **Contextual rules**: Applied based on domain and risk level

### Execution Review Findings (2026-02-13)

A code-level analysis revealed three root causes of execution failure:

#### Root Cause 1: Two Disconnected Execution Planes

- **Plane A (worker-runner)**: Calls Vertex AI (Gemini 2.5 Pro) directly with a hardcoded model string, reports to OASIS
- **Plane B (Conductor/LLM Router)**: Routes by role (Planner->Claude, Worker->Gemini Flash, Validator->Claude), has fallback logic and telemetry

These two systems do not interact. The worker-runner does not call the LLM Router. The Conductor is a 17-line stub (health endpoint + `POST /crew -> {status: success}`).

#### Root Cause 2: Declarative Contracts Without Runtime Enforcement

The guardrails YAML declares contracts, but nothing validates that LLM outputs conform. The worker-runner sends a prompt, gets freeform text back, and acts on it. No schema gate exists between LLM response and action execution.

#### Root Cause 3: No Feedback Loop

When a VTID fails: status set to `failed`, OASIS event emitted, nothing else happens. No failure analysis, no pattern extraction, no prompt improvement, no routing adjustment. The system has observability but no introspection.

### Config Drift

Three sources of truth for model assignments:

| Source | Planner | Worker | Validator |
|--------|---------|--------|-----------|
| `crew_template/crew.yaml` | gemini | claude | chatgpt |
| `conductor/llm-router/router.py` | claude-3-5-sonnet | gemini-1.5-flash | claude-3-5-sonnet |
| `worker-runner/execution-service.ts` | N/A | gemini-2.5-pro (hardcoded) | N/A |

### Confirmed vs Disputed Claims

| Claim | Verdict |
|-------|---------|
| Supabase + Prisma stable | CONFIRMED |
| Gateway live on Cloud Run | CONFIRMED (78+ route files) |
| GitHub webhooks streaming into OASIS | CONFIRMED |
| Crew Template v1.2 frozen | PARTIALLY FALSE -- not versioned as 1.2 |
| Constitution in DB | FALSE -- governance via YAML + VTID control |
| Memory-Indexer deployed | TRUE BUT DEPRECATED (VTID-01184) |
| Conductor deployed | EFFECTIVELY FALSE -- 17-line stub |
| VTID governance active | CONFIRMED (300+ event types) |
| Autonomous end-to-end reliable | FALSE -- but root cause differs from external diagnosis |

### Recommended Fix Priority

| Priority | Action |
|----------|--------|
| P0 | Resolve config drift (single model-assignment config) |
| P0 | Wire LLM Router into worker-runner OR delete Conductor stub |
| P1 | Add JSON Schema validation on LLM outputs |
| P1 | Add DB-level VTID state transition constraints |
| P2 | Close projector->worker push loop for true autonomy |
| P2 | Build failure analyzer service |
| P3 | Prompt versioning + performance tracking |
| P3 | Consolidate memory to pgvector (retire Mem0+Qdrant) |

### What NOT to Do

- Do not add another orchestration framework
- Do not rebuild Supabase/OASIS/Gateway
- Do not switch clouds or providers
- Do not add more LLM providers until existing configs agree
- Do not design for "general AGI autonomy" -- design for deterministic task execution

## Related Pages

- [[autopilot-system]]
- [[crewai]]
- [[cognee-integration]]
- [[autopilot-automations]]

## Sources

- `raw/autonomy/vitana-autonomous-architecture-v1.md`
- `raw/autonomy/autonomous-execution-review-2026-02-13.md`

## Last Updated

2026-04-12
