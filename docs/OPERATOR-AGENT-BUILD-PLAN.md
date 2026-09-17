# Operator Execution Agent — build plan (W0 → W7)

**Status:** living plan, started 2026-09-17. Owner: platform owner (d.stevanovic@exafy.io).
**Source analysis:** `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` (verdict, chain, gap
matrix, target architecture, roadmap R-0…R-11). This document is the execution order for
that roadmap, one wave per PR family, each slice on its own VTID.

## Goal

The Command Hub Operator Console executes development tasks on `vitana-platform` and
`vitana-v1` the way a Claude Code session does: it can read any file it was not handed,
search the codebase, run tests before opening a PR, iterate on a failure, touch either
repo, take an open-ended request, and observe its own result — under the same governance
(VTID, safety gate, validator contract, staging-first) the platform already enforces.

## Model policy — STANDING (corrected 2026-09-17)

| Stage | Primary | Fallback | Where it is set |
|---|---|---|---|
| Operator chat (`operator`) | `deepseek/deepseek-flash` (DeepSeek-V4.1-Flash) | `bedrock/eu.anthropic.claude-sonnet-4-6` | `llm_routing_policy` v17 |
| **Agent executor** (W1) | **`deepseek/deepseek-flash`** via `callViaRouter('worker', …, { providerOverride: 'deepseek', modelOverride: 'deepseek-flash' })` | the `worker` stage's own policy fallback — **`bedrock/eu.anthropic.claude-sonnet-4-6`** (v17) | on-ramp `llm_on_ramp_override` + policy fallback |
| Triage | `bedrock/eu.anthropic.claude-sonnet-4-6` | `deepseek/…` | `llm_routing_policy` v17 |

- **DeepSeek Flash 4.1 is the primary. Bedrock (Claude) is the fallback.** Not the other
  way round. The native tool loop runs on DeepSeek's OpenAI-style `tools`/`tool_calls`
  (`deepseekAdapter` already supports it); Bedrock serves the same loop when DeepSeek
  fails, via the router's existing fallback (VTID-03820 semantics — override replaces
  PRIMARY only, the stage's fallback still applies).
- Claude Code CLI (`claude -p` on Bedrock, the orphaned `services/autopilot-worker`
  lane) is **not** the primary backend and is not required for any wave. It remains an
  optional fallback backend behind its own flag; never `provider:'anthropic'`.
- Never Google (`vertex`) for any stage — CLAUDE.md rule 27.

## Waves

| Wave | VTID | What lands | Owner-gated? |
|---|---|---|---|
| **W0** | VTID-04005 | This plan. CI watcher attaches the failing Actions **job-log excerpt** to the failure reason (`dev-autopilot-ci-logs.ts`) so triage/self-heal children reason from evidence. Executions are **stamped with the claiming environment** at claim time and every watcher/reconciler skips rows it does not own (`dev-autopilot-env-ownership.ts`; fixes the Run #2 cross-env dry-run incident at the root, on top of VTID-04004). On-ramp can **self-allocate + register a VTID** for exafy_admin-instructed work — server-side only, behind `OPERATOR_VTID_SELF_ALLOCATE_ENABLED` (default OFF); the operator tool contract still requires `vtid` until the owner enables and wires it. `dev_autopilot_config.allow_scope` widened to the trees a session touches (`services/gateway/src/**`, `docs/**`, `scripts/**`, `config/**`, `DATABASE_SCHEMA.md`, sibling services) — **not** `CLAUDE.md`, not anything in `deny_scope`. | Prod flag pins (`DEV_AUTOPILOT_USE_JOB=true`, `DEV_AUTOPILOT_JOB_CLOUD=aws`, `OPERATOR_*_READ` flags) via `AWS-PROD-DEPLOY-GATEWAY.yml` env-only — **owner decision**, not done here. |
| **W1** | VTID-04006 | **Agentic executor** in the existing executor image: `services/gateway/src/services/autopilot-agent/` — shallow clone of the target repo into a scratch dir, a native **tool loop** (`read_file`, `list_dir`, `grep`, `glob`, `write_file`, `edit_file`, `run_command` allowlisted to `tsc`/`jest`/`git diff`) on **deepseek-flash with Bedrock fallback**, local `tsc --noEmit` + related jest before the PR, ≤3 fix iterations, **post-hoc allow/deny scope check on `git diff --name-only`** (same `evaluateSafetyGate` globs), PR contract + evidence pack (VTID-04002), OASIS step events. Selected by `DEV_AUTOPILOT_EXECUTOR=agent` (env) or `metadata.executor='agent'` on the row; the single-shot path stays the default. `Dockerfile.job` gains `git` and the dev toolchain. | Executor image rebuild = `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` dispatch (reason required). |
| **W2** | VTID-04007 | **Open-ended intake** — shipped 2026-09-17: `autopilot_run_task(request, title?)` in the tool registry, on the operator wire schema and in both prompt sources; `executeRunTask` (same VTID-03851 authz + governance shape as `execute_task`) → `triggerOperatorExecution({ openEnded: true })` → W0 self-allocation registers the VTID with `intake:'open_ended'` → the execution row is pinned to the **agent** executor (only the agent can discover files) → the agent's task prompt switches to discovery mode; scope/deny globs, the test-coverage rule and tsc/jest are enforced on the real diff post-hoc (VTID-04006). Empty file list is accepted only with `openEnded`. | Still requires `OPERATOR_VTID_SELF_ALLOCATE_ENABLED=true` on staging — **not** pinned by this VTID; until the owner flips it the tool answers with the honest refusal. Then Run #5. |
| **W3** | VTID-04017 | **CI feedback loop in fix mode** — shipped 2026-09-17: when CI fails on an agent-executor PR the bridge no longer closes it; the child carries `metadata.fix_mode` (branch/PR/parent) plus the W0 log excerpt, the runner clones that branch, gets a fix-mode task prompt (PR files, CI evidence, attempt N of M), re-runs the post-hoc checks on the whole PR diff, refuses to push if it edited nothing, fast-forwards onto the same branch and returns the same PR so the watcher keeps tracking it; escalation leaves the PR open. The PR-flood guard now exempts the fix target. Rounds stay capped by `max_auto_fix_depth`. Per-run tokens/cost land on `dev_autopilot_outcomes.metadata.agent_runs[]` (no migration). | Live exercise = Test Run #6 (an agent PR whose first attempt breaks a paired test). Executor image rebuild after merge. |
| **W4a** | VTID-04018 | **Session bootstrap pack (§4.1)** — shipped 2026-09-17: `operator-bootstrap-pack.ts` assembles, per turn, CLAUDE.md Part 1 rules + the newest 20 change-log rows (GitHub read — the container has no CLAUDE.md), the service path map, the `DATABASE_SCHEMA.md` table index, live build-info for the gateways in `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS`, open PRs on both repos with the platform's CI state, the last 10 `deploy.*`/`dev_autopilot.*` OASIS events, and the tool catalog rendered from the declarations the model is actually given. Each source bounded, timed out (2.5 s) and fail-open; sections cached 5 min with coalesced builds; ~30–40 KB cap; appended to BOTH the main turn and the tool-result turn. Gated on `OPERATOR_BOOTSTRAP_PACK_ENABLED` (pinned on staging). The VTID-03930 orientation block stays. | Live: first operator turn on staging after deploy. |
| **W4b** | VTID-04022 | **Server-side threads + rolling summaries (§4.3)** — shipped 2026-09-17: `operator-threads.ts` records every `/api/v1/operator/chat` turn (thread upsert + user/tool/assistant messages) into `operator_threads`/`operator_messages`, rewrites a rolling summary every `OPERATOR_THREAD_SUMMARY_EVERY` (10) turns through the `memory` routing stage (Bedrock primary / DeepSeek fallback, never Google), and `processWithGemini` recalls `dev_agent_memory` against summary + current message (`buildRecallQuery`). Fail-open everywhere (missing table logs once; router/Supabase errors never touch the reply); gated on `OPERATOR_THREADS_ENABLED` (default off, not pinned anywhere yet). **W4c (VTID-04025, shipped 2026-09-17):** `operator-turn-memory.ts` — the `memory` stage extracts ≤3 durable facts per non-trivial turn into `dev_agent_memory` (decision/convention/incident/preference/gotcha), and the executor writes `task_outcome` (PR opened) / `gotcha` (run failed, reason inline) rows; gated on `OPERATOR_TURN_MEMORY_ENABLED`, default off. **Recall ranking (VTID-04027):** 20 candidates → top-10 category-diverse (cap 4/category) → bounded block (6 KB). **Still open:** diff preview + Approve before PR (§4.6) — the SSE stream is W4d below. | Migration applied 2026-09-17 22:20 UTC (Supabase MCP, pre/post-checked, tables empty); the flag pin on staging (`OPERATOR_THREADS_ENABLED=true`) is the remaining step. |
| **W4d** | VTID-04028 | **Streamed operator turn + live tool transcript (§4.6)** — shipped 2026-09-17: `processWithGemini({ onEvent })` emits `model.turn`/`tool.call`/`tool.result` (bounded args/excerpt, per-tool `duration_ms`, fire-and-forget) around the real tool loop; the `/chat` handler body is `runOperatorChatTurn()` shared by `POST /chat` (unchanged) and new `POST /chat/stream` (same validation/authz/OASIS/threads/memory, framed as SSE: `turn.started → transcript → reply (the /chat body) or error → done`, 15 s heartbeat, `res.on('close')` for client-gone). The Command Hub streams first (fetch body reader — EventSource cannot POST), renders the transcript live (running/ok/failed states, durations kept on the final activity lines) and falls back to `/chat` only when no stream is obtainable. Visually verified on a local harness (1400×900 + 390×844), not live. **Still open from §4.6:** diff preview + Approve/Reject before a PR (commit-tier, maker-checker style), cost/model badge, cancel. | No flag, no secret, no task-def change — the console picks the stream route automatically; a gateway without it falls back to `/chat`. |
| **W5a** | VTID-04020 | **CloudWatch logs read** — shipped 2026-09-17: `dev_cloudwatch_logs` (`aws-cloudwatch-logs-readonly.ts`, `FilterLogEventsCommand` only) over `/ecs/vitana-<service>` groups, bounded window/limit/payload, behind `OPERATOR_AWS_READONLY_ENABLED`, developer/admin only, IAM denial surfaced verbatim. `ecs:Describe*` already existed (VTID-03836). | **Answered live 2026-09-17 22:18 UTC (staging on `54e97c5`):** the first `dev_cloudwatch_logs` call returned, verbatim, `User: arn:aws:sts::472838866351:assumed-role/vitana-ecs-task-role/… is not authorized to perform: logs:FilterLogEvents on resource: arn:aws:logs:eu-central-1:472838866351:log-group:/ecs/vitana-gateway because no identity-based policy allows the logs:FilterLogEvents action` — the tool's honest-error posture worked; the grant (`logs:FilterLogEvents` + `logs:DescribeLogGroups` on `arn:aws:logs:eu-central-1:472838866351:log-group:/ecs/vitana-*`) is the owner's, on `vitana-ecs-task-role`, declared in IaC/the deploy workflow, never hand-edited. |
| **W5b** | VTID-04023 (SQL) | **Read-only SQL — shipped 2026-09-17:** `dev_run_sql_readonly` (`operator-sql-readonly.ts`) — one SELECT / WITH … SELECT / plain EXPLAIN over a dedicated `OPERATOR_SQL_READONLY_DATABASE_URL` connection, validated (single statement, comments stripped, no locking/`INTO`/data-modifying CTE, forbidden server-side functions), run in `BEGIN READ ONLY` with `SET LOCAL` timeouts and always rolled back, wrapped in `LIMIT n+1`, cells/payload bounded, logged with a statement fingerprint; behind `OPERATOR_SQL_READONLY_ENABLED`, developer/admin only; `not_configured` until the URL exists. **Still W5b, not done:** the deploy-workflow dispatch table; the **`vitana-v1` write lane** (frontend `allow_scope` + preview-deploy verification). | Owner: a read-only login role on the Aurora reader + its Secrets Manager entry + task-def wiring in `AWS-STAGE-DEPLOY-GATEWAY.yml`; a vitana-v1 write token for the write lane. |
| W6 | next | Index service: RepoWise + Graphify built in CI on merge, published to S3, `dev_index_query`/`dev_graph_path`/`dev_get_risk` tools; pulled into the agent task at start. | S3 bucket + CI secrets — owner. |
| W7 | VTID-04019 (a) | Hardening. **(a) shipped 2026-09-17:** the partial PATs are out of `CLAUDE.md` §16 (replaced by where the tokens live + the leak rule) and a drift test scans CLAUDE.md/README/docs for token shapes. **Still open:** rotate the two tokens whose prefixes were exposed; declare the prod gateway's operator/autopilot flags in `AWS-PROD-DEPLOY-GATEWAY.yml`; retire the single-shot executor once W1 has ≥10 green runs; confirm/perform the Supabase `service_role` rotation. | Rotations + prod flags — owner. |

## Test runs

- **Run #4** (after W1, staging): the same task as Run #3 on the agent executor; compare
  wall-clock, diff size, CI outcome, cost. **Done 2026-09-17** — see gap analysis §8. Run #4
  (VTID-04008, `47a4d6eb`) found and edited the unlisted caller but was blocked by three executor
  defects (tsc heap OOM → VTID-04009; watchdog reclaiming a live run and clobbering metadata →
  VTID-04011; TS2742 on the symlinked node_modules → VTID-04013). Run #4b (VTID-04012, `4f7d5ea4`,
  on the VTID-04009 image) opened PR #3382 in 9 min 07 s, complete vs the plan, DeepSeek Flash end
  to end, no Bedrock fallback.
- **Run #5** (after W2, staging): a vague request ("the CI failure reason should name the
  checks") with no VTID and no files; success = VTID allocated, PR green, scope respected.
  **Blocked on the flag flip** (`OPERATOR_VTID_SELF_ALLOCATE_ENABLED=true` on
  `AWS-STAGE-DEPLOY-GATEWAY.yml`) as of 2026-09-17; W2's code is merged and inert until then.
  Also worth reading in that run's evidence pack: `checks_refused_by_guard` (VTID-04016).
- **Run #6** (after W3, staging): an agent PR whose first attempt fails CI (e.g. ask for a change
  and a test that contradicts it, or let `validate-pr` reject a missing evidence file); success =
  the SAME PR goes green from a fix-mode child (`self_heal_injected` with `fix_mode:true`, no
  second PR, parent `self_healed`), and `agent_runs[]` on the outcome row shows both runs' cost.

## Governance notes recorded during W0

- Two harness safety flags fired while building W0 and were respected, not bypassed:
  (1) auto-approving a self-allocated VTID from the operator tool was flagged as a
  governance weakening → shipped **server-side, default-off, flag-gated**, tool contract
  unchanged; (2) adding `CLAUDE.md` to the executor's allow scope was flagged as
  self-modification → **not added**. Both are the owner's call, on the record here.
- Ownership stamping deliberately treats unstamped rows as legacy-visible to every
  environment, so nothing already in flight is orphaned by the deploy.
