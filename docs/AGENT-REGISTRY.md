# Agent Registry — every LLM-driven agent in the platform (VTID-04222)

**Status:** living inventory, first cut 2026-09-21. Read-only: this document
records what is, not what should be. It is the checklist for the program that
follows it (executor memory, codebase index, per-responsibility tool sets,
prod parity, model policy) — a row is "green" when memory-in, memory-out,
tools and stage are all real for that agent.

**How the facts were established (not assumed):**

- LLM stage → provider/model: the ACTIVE `llm_routing_policy` row, read
  through the governed `GET /api/v1/llm/routing-policy` on BOTH gateways
  2026-09-21 14:20 UTC. Both return the same row: `environment=DEV`,
  **version 17**, `is_active=true`. `LLM_ROUTING_ENV` is pinned on neither
  task definition (grep of both deploy workflows + the live task defs), so
  staging and production resolve the **same** policy row.
- Live env pins: `aws ecs describe-task-definition` on `vitana-gateway`
  (staging, **rev 487**, image `gateway:a8a8e841e3da`), `vitana-gateway-awsdr`
  (prod, **rev 114**, image `gateway:a286b94abc0e`) and
  `vitana-autopilot-executor` (**rev 20**, image `autopilot-executor:a8a8e841e3da`).
- Memory / tools / gates: the source files named in each row.
- Codeintel live state: one read-only Operator Console turn on staging
  (thread recorded in `docs/validation/VTID-04222/`), plus the staging
  build log of run 503.

## 1. Live policy v17 (stage → primary / fallback)

| Stage | Primary | Fallback | Notes |
|---|---|---|---|
| `operator` | deepseek / `deepseek-flash` | bedrock / `eu.anthropic.claude-sonnet-4-6` | VTID-03817 |
| `worker` | bedrock / `eu.anthropic.claude-opus-4-5-20251101-v1:0` | bedrock / `eu.anthropic.claude-sonnet-4-6` | the agent executor overrides the PRIMARY to deepseek-flash (VTID-04006); the fallback still applies |
| `planner` | bedrock / opus-4-5 | bedrock / sonnet-4-6 | |
| `validator` | bedrock / opus-4-5 | bedrock / sonnet-4-6 | |
| `triage` | bedrock / sonnet-4-6 | deepseek / **`deepseek-chat`** | retired alias (VTID-03816) — still served by DeepSeek, on a discontinuation clock |
| `memory` | bedrock / sonnet-4-6 | deepseek / **`deepseek-chat`** | same |
| `classifier` | bedrock / sonnet-4-6 | deepseek / **`deepseek-chat`** | same |
| `vision` | bedrock / opus-4-5 | bedrock / sonnet-4-6 | |

- **No stage is on `anthropic` or `vertex`.** Standing rules 10a/10b/27 hold
  on the active row.
- **Catalog (`llm_allowed_models`, 22 active rows):** every provider/model
  the agents below use is present — `deepseek/deepseek-flash`,
  `bedrock/eu.anthropic.claude-sonnet-4-6`, `bedrock/…opus-4-5…` — so the
  governed policy endpoint accepts edits (VTID-03817 lesson). But the
  catalog ALSO still lists as active: 6 `anthropic/*` rows, 6 `vertex/gemini-*`
  rows, `deepseek-chat`, `deepseek-reasoner`, and the `vertex` and
  `anthropic` providers themselves (`llm_providers.is_active=true`). Nothing
  routes to them today; they are one Command Hub dropdown save away.
  Deactivating them is a governed-endpoint change that affects prod
  immediately (shared row) — recorded here as an **owner decision**, not
  done.
- **Prod has no DeepSeek credential.** `vitana-gateway-awsdr` rev 114 carries
  no `DEEPSEEK_API_KEY` secret (staging does). `llm-router.ts`'s deepseek
  adapter reports `isAvailable() === false` without it, so on production
  every `operator` turn resolves to the Bedrock fallback. Structural
  inference from the adapter code; not measured on prod traffic
  (`llm.call.*` events would confirm it).

## 2. The registry

Legend — **Memory in**: what the agent reads at start beyond its immediate
input. **Memory out**: what it writes that a later run can read. **Pins**:
what the live task definitions actually carry (staging rev 487 / prod rev 114
/ executor rev 20), not what a workflow file declares.

| # | Agent | Entry point | LLM stage → live provider/model | Memory in | Memory out | Tools | Env gate | Staging pin | Prod pin |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Operator Console chat** | `services/gemini-operator.ts` `processWithGemini()` ← `routes/operator.ts` `/api/v1/operator/chat` (+ `/chat/stream`) | `operator` → deepseek/deepseek-flash, fb bedrock/sonnet-4-6 | **Y** — W4a bootstrap pack (`operator-bootstrap-pack.ts`: CLAUDE.md Part 1 + 20 change-log rows, service map, schema index, build-info, open PRs, recent events, tool catalog), `dev_agent_memory` recall (20 candidates → top-10 category-diverse, `dev-memory-ranking.ts`) against `buildRecallQuery(threadSummary, text)`, thread rolling summary (`operator-threads.ts`) | **Y** — `operator_threads`/`operator_messages` per turn; ≤3 facts/turn into `dev_agent_memory` (`operator-turn-memory.ts`, memory stage); `writeDevMemory` on five tool outcomes | 41 registry tools (`tool-registry.ts`) + the dev wire tools in `gemini-operator.ts`: `dev_search_codebase`, `dev_read_file` (CODEBASE_READ), `dev_aws_ecs_status`, `dev_cloudwatch_logs`, `dev_ecs_tasks` (AWS_READONLY), `dev_repowise`, `dev_graphify` (CODEINTEL), `dev_run_sql_readonly` (SQL_READONLY), `dev_db_query` (DB_READONLY), `run_code`, `investigate_failure`, community/search tools. `dev_*` hard-blocked for non-developer/admin roles | `OPERATOR_*_ENABLED` per tool family; on-ramp `OPERATOR_EXECUTION_ONRAMP_ENABLED` + exafy_admin marker (VTID-03851) | all 14 operator flags `true`, `OPERATOR_ONRAMP_EXECUTOR=agent`, `OPERATOR_CODEINTEL_ENABLED=true`, `CODEINTEL_*_REPO_DIR` set, `DEEPSEEK_API_KEY` secret present | **only** `OPERATOR_EXECUTION_ONRAMP_ENABLED=true`; no bootstrap pack, no threads, no turn memory, no read tools, no SQL, no codeintel, no DeepSeek key → the single-shot zero-tool console the gap analysis §0 describes |
| 2 | **Agent executor** | `services/autopilot-agent/run-agent-execution.ts` `runAgentExecutionSession()` ← `job-entry.ts` (ECS task `vitana-autopilot-executor`, dispatched by the staging gateway's executor tick) | `worker` with `providerOverride: deepseek/deepseek-flash` (VTID-04006 standing policy); fallback = the worker stage's own bedrock/sonnet-4-6 | **partial** — CLAUDE.md Part 1 excerpt read from the clone (≤14 KB) + `loadAutopilotContext()` conventions block. **No** bootstrap pack, **no** `dev_agent_memory` recall, **no** prior `agent_runs` — a retry does not know what attempt N-1 did | **indirect only** — the executor task writes nothing itself; the gateway's `applyExecutionResult` (`dev-autopilot-execute.ts:3065/3102`) writes `task_outcome` / `gotcha` rows via `recordExecutionOutcomeMemory` (gated on the GATEWAY's `OPERATOR_TURN_MEMORY_ENABLED`) and `recordAgentRunUsage` appends `metadata.agent_runs[]` on the finding's `dev_autopilot_outcomes` row | `read_file`, `list_dir`, `search_text`, `find_files`, `write_file`, `edit_file`, `delete_file`, `run_check(tsc\|jest\|node_check\|git_diff\|git_status)`, `finish` (`agent-tools.ts`) — no shell, no index, no memory tool | row `metadata.executor='agent'` (stamped by the on-ramp from `OPERATOR_ONRAMP_EXECUTOR=agent`) or `DEV_AUTOPILOT_EXECUTOR=agent` | executor rev 20: `AGENT_MAX_TURNS=120`, `AGENT_DEADLINE_MS=2100000`, `BEDROCK_ROLE_ARN`, `AWS_BEDROCK_REGION`, `DEEPSEEK_API_KEY` secret, `GITHUB_SAFE_MERGE_TOKEN`; no `OPERATOR_*` flag on the task | prod gateway `DEV_AUTOPILOT_EXECUTOR_ENABLED=false` → prod never dispatches an execution |
| 3 | **Single-shot executor** | `services/dev-autopilot-execute.ts` `runExecutionSession()` → `callRoutedLlm()` | `worker` → bedrock/opus-4-5, fb sonnet-4-6 (or the row's `llm_on_ramp_override`) | **partial** — `loadAutopilotContext()` + the plan's `files_referenced` contents, nothing else | same indirect `applyExecutionResult` path as row 2 | **none** — one call must emit whole replacement files for ≤8 pre-fetched paths | default executor when row 2 is not selected | as row 1/2 | as row 2 |
| 4 | **Planner** | `services/dev-autopilot-planning.ts` `callRoutedLlm()` | `planner` → bedrock/opus-4-5, fb sonnet-4-6 (`DEV_AUTOPILOT_PLANNING_MODEL` is declared but never handed to the router) | **N** — reads the files it will plan against from GitHub; no memory, no bootstrap, no index | **N** as memory — writes `dev_autopilot_plan_versions` (a plan, not a durable fact) | none | `DEV_AUTOPILOT_PLANNING_STUB_ENABLED` (stub path only); otherwise always on | — | — |
| 5 | **Validator / LLM review** | `services/dev-autopilot-llm-review.ts` `reviewExecutionPr()` | `validator` → bedrock/opus-4-5, fb sonnet-4-6 | **N** — sees only the diff bundle | **N** — verdict is logged; fail-open (a failed call passes) | none — no file read beyond the diff, no CI log excerpt (`dev-autopilot-ci-logs.ts` feeds triage, not review), no risk signal | `DEV_AUTOPILOT_LLM_REVIEW_ENABLED` | `true` | unset → off |
| 6 | **Operator planner (spec drafts)** | `services/operator-planner.ts` `generateSpecForTask()` → self-fetch `POST /api/v1/specs/:vtid/generate` → `routes/specs.ts` `generateSpecWithLLM()` | **NOT a routing stage.** `callClaudeText({ model: CLAUDE_SONNET_4_6 })` (`claude-text-client.ts` → `invokeBedrock()` directly): no policy row, no fallback, no `llm.call.*` telemetry, no cost badge | **N** — `gatherSystemContext()` (spec-shaped context from the ledger), no memory, no index | `oasis_specs` draft (`spec_status='draft'`) | none | `OPERATOR_PLANNER_ENABLED`, `OPERATOR_PLANNER_INTERVAL_MS` | `true` | unset → off |
| 7 | **Self-healing triage** | `services/self-healing-triage-service.ts` `spawnTriageAgent()` ← `dev-autopilot-bridge.ts:611`, `self-healing-reconciler.ts:723`, `routes/self-healing.ts` | `triage` → bedrock/sonnet-4-6, fb deepseek/deepseek-chat | **partial** — pre-fetches ≤50 `oasis_events` for a session id found in the diagnosis; no `dev_agent_memory`, no `architecture_reports`, no logs | **N** as memory — the report goes back to the caller (execution metadata / self-heal decision) | none (the file still declares the dead Managed-Agents constants `ANTHROPIC_API_KEY`, `TRIAGE_AGENT_ID`, `TRIAGE_ENVIRONMENT_ID`) | reconciler `SELF_HEALING_RECONCILER_ENABLED !== 'false'`; bridge unconditional on execution failure | — | — |
| 8 | **Architecture investigator** | `services/architecture-investigator.ts` `investigateIncident()` ← operator tool `investigate_failure`, `routes/architecture-investigator.ts` (SERVICE_AUTH_TOKEN) | **NOT routed.** Direct `fetch` to `https://api.deepseek.com/chat/completions` with `DEEPSEEK_API_KEY`, model `ARCH_INVESTIGATOR_MODEL \|\| deepseek-flash`: no fallback, no cost accounting, no policy | recent `oasis_events` for the topic | **Y** — `architecture_reports` row + `architecture.investigation.completed` event | none | needs `DEEPSEEK_API_KEY`; throws `DEEPSEEK_API_KEY not set` otherwise | key present | **no key on prod** → the operator's `investigate_failure` tool fails on prod |
| 9a | **Memory job — thread summary** | `services/operator-threads.ts` (every `OPERATOR_THREAD_SUMMARY_EVERY`=10 turns) | `memory` → bedrock/sonnet-4-6, fb deepseek/deepseek-chat | last 30 messages + prior summary | `operator_threads.summary` | none | `OPERATOR_THREADS_ENABLED` | `true` | unset |
| 9b | **Memory job — turn memory** | `services/operator-turn-memory.ts` `extractAndRecordTurnMemory()` / `recordExecutionOutcomeMemory()` | `memory` (extraction call); the outcome writer is deterministic | the turn transcript (bounded 6 KB) | `dev_agent_memory` (decision/convention/incident/preference/gotcha/task_outcome), embedded via `dev-memory-embedding.ts` (Titan on Bedrock) | none | `OPERATOR_TURN_MEMORY_ENABLED` | `true` | unset |
| 10 | **cognee-extractor** | `services/agents/cognee-extractor/main.py` (FastAPI + litellm) ← `services/gateway/src/services/cognee-extractor-client.ts` `extractAsync()` | **NOT routed.** `LLM_PROVIDER` default `gemini` / `gemini/gemini-3.1-pro-preview` (dead, GCP is off); deepseek only when `LLM_PROVIDER=deepseek` + `DEEPSEEK_API_KEY` | the session transcript | `memory_facts` (`write_fact`), `relationship_nodes`, `memory_items` — via the gateway client, not the service | none | gateway: `COGNEE_EXTRACTOR_URL` (client `enabled = !!env`) | **unset on both gateways** → `extractAsync` never fires. ECS service `vitana-cognee-extractor` is ACTIVE 1/1 on task def `:5` with **no LLM env at all** (only the three Supabase secrets) — it is running, unreachable by the gateway, and could not call any model if reached | same |

### Other router consumers (not agents in the sense above, listed so no stage is invisible)

| Stage | Files |
|---|---|
| `operator` | `assistant-service.ts` |
| `worker` | `db-i18n/translator.ts`, `journey/goal-plan-i18n.ts`, `recommendation-engine/analyzers/llm-analyzer.ts`, `dev-autopilot-pr-contract.ts` (log text only) |
| `planner` | `journey/goal-planner-service.ts`, `shopping-agent/agent-core.ts` |
| `triage` | `routes/triage-agent.ts`, `feedback-llm-resolvers.ts`, `natural-language-service.ts` |
| `memory` | `inline-fact-extractor.ts`, `knowledge-hub.ts`, `user-model-synthesis.ts`, `guide/session-summaries.ts` |
| `vision` | `anthropic-vision-client.ts`, `assistant-core.ts` |
| direct Bedrock (`callClaudeText`, no stage) | `routes/specs.ts`, `matchmaker-agent.ts`, `intent-extractor.ts`, `intent-classifier.ts`, `voice-architecture-investigator.ts`, `self-healing-spec-service.ts` |

## 3. Codebase index — live state (the W6 gap, measured)

CLAUDE.md's "Mandatory Codebase Intelligence Workflow" is satisfiable by
**no agent today**:

- **Operator Console (staging):** `dev_repowise status` returned, verbatim,
  `not_configured: "repowise" is not installed in this runtime`, and
  `dev_graphify` was not in the catalog the model was given on that turn.
- **Root cause, from the staging build log (run 503, step `#23`):**
  `pip install repowise graphifyy` on `node:20-alpine` fails with
  `ResolutionImpossible` — every `repowise` release depends on
  `lancedb<1,>=0.12`, and lancedb publishes **no musllinux wheel**
  (`pip download --platform musllinux_1_2_x86_64 lancedb` → "No matching
  distribution"). The VTID-04118 block is `|| echo`-guarded, so the image
  builds and the tools report `not_configured` forever. `graphifyy` itself
  is a pure-Python wheel, but it sits in the same `&&` chain and never runs.
- **Agent executor:** `Dockerfile.job` has no Python, no index, no tools.
- **Sessions:** `.claude/hooks/session-start-codeintel-setup.sh` installs
  both CLIs per session; this sandbox has `graphify-out/graph.json` (51 MB,
  47,270 nodes) but no `.repowise/wiki.db`.

Consequence for item 3 of the program: the index must be **built where pip
works (CI, ubuntu) and published**, and the runtime must **not need lancedb**
— Graphify's `graph.json` is plain JSON and can be traversed without the
CLI; RepoWise's per-file history/risk signal has to be exported at build
time or the runtime image has to leave Alpine.

## 4. Cross-cutting findings (ranked)

1. **Two agents bypass the routing policy entirely** — the architecture
   investigator (direct DeepSeek fetch) and the spec generator behind the
   operator planner (direct Bedrock). Neither has a fallback, cost record,
   or `llm.call.*` telemetry; the investigator hard-fails on prod (no key).
2. **The agent executor has no memory at all** — no bootstrap, no recall,
   no prior-attempt record. Fix mode re-reads the CI evidence but never
   what attempt N-1 tried.
3. **Validator, planner and triage are tool-less single-shot calls** —
   the validator cannot read a file the diff touches, triage cannot read a
   log or an `architecture_reports` row.
4. **Production runs a different operator than staging** — rev 114 pins one
   flag and lacks the DeepSeek secret; the shared policy row makes prod's
   `operator` primary silently unavailable.
5. **Three stage fallbacks sit on the retired `deepseek-chat` alias**; the
   catalog still offers `vertex`/`anthropic` models to the dropdown.
6. **cognee-extractor is running on ECS with no LLM configured and no
   caller** — a live but dead memory pipeline.

## 5. Program checklist (rows go green as the follow-up VTIDs land)

| Agent | Memory in | Memory out | Tools scoped | Routed stage |
|---|---|---|---|---|
| Operator chat | ✅ | ✅ | ✅ (codeintel not live) | ✅ |
| Agent executor | ❌ | ⚠️ indirect | ⚠️ no index | ✅ |
| Single-shot executor | ⚠️ | ⚠️ indirect | ❌ | ✅ |
| Planner | ❌ | ❌ | ❌ | ✅ |
| Validator | ❌ | ❌ | ❌ | ✅ |
| Operator planner | ❌ | ⚠️ spec only | ❌ | ❌ direct Bedrock |
| Self-healing triage | ⚠️ events only | ❌ | ❌ | ✅ |
| Architecture investigator | ⚠️ events only | ✅ | ❌ | ❌ direct DeepSeek |
| Memory jobs (9a/9b) | ✅ | ✅ | n/a | ✅ |
| cognee-extractor | n/a | ❌ dead path | n/a | ❌ unrouted, unconfigured |
