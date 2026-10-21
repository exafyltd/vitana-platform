# VTID-04232 — Self-healing triage tools: events / CloudWatch logs / ECS tasks / read-only SQL / architecture_reports on the `triage` stage

Build plan item 4, `docs/AGENT-REGISTRY.md` §4 finding 3 (triage half).
`spawnTriageAgent()` pre-fetched the OASIS events of the one session named
in the diagnosis and asked the `triage` stage for a report in a single shot
— while its own prompt told the model to "call query_oasis_events" and
"read the source code in /workspace/repo/", tools it has not had since the
Managed-Agents flow was retired. It now runs the shared bounded stage loop
(`llm-stage-tool-loop.ts`, VTID-04231) with five read-only investigator
tools (`self-healing-triage-tools.ts`), every one an existing gateway read
path reused, not rebuilt.

VALIDATION_PROFILE: gateway_backend

## Acceptance Criteria

AC-1 — Triage runs on the `triage` stage with `service:'self-healing-triage'`, the incident VTID, `allowFallback:true`, `maxTokens:4000`, the five tools declared (`query_oasis_events`, `dev_cloudwatch_logs`, `dev_ecs_tasks`, `dev_run_sql_readonly`, `get_architecture_reports`) and a prompt that names them and no longer names `/workspace/repo`.
TEST: `services/gateway/test/vtid-04232-triage-tools.test.ts` — "runs the triage stage with the five tools …".

AC-2 — The diagnosis-session pre-fetch is unchanged (events inlined into the prompt), and `query_oasis_events` also reads by VTID; neither filter is refused with an error string, never a throw.
TEST: same suite — "still pre-fetches the diagnosis session events into the prompt", "queryOasisEvents reads by session id … or by vtid".

AC-3 — `dev_cloudwatch_logs` and `dev_ecs_tasks` honour `OPERATOR_AWS_READONLY_ENABLED` (refused honestly when not `true`, forwarded to `filterVitanaLogs` / `listEcsTasks` when `true`); an IAM denial comes back verbatim as an error result.
TEST: same suite — "the AWS reads are refused honestly …".

AC-4 — `dev_run_sql_readonly` honours `OPERATOR_SQL_READONLY_ENABLED` and runs `runReadonlySql` (validated SELECT, READ ONLY transaction) with a `triage:<vtid>` thread id.
TEST: same suite — "dev_run_sql_readonly is refused when the switch is off …".

AC-5 — `get_architecture_reports` reads `architecture_reports` newest-first by exact VTID or incident-topic substring, bounded, and says so when empty.
TEST: same suite — "get_architecture_reports reads newest-first …".

AC-6 — The loop is bounded (≤8 turns, ≤10 tool calls, 180 s, then one tool-less call for the report); the parsed report carries `llm_provider`/`llm_model`/`llm_fallback_used`/`tool_calls`/`tools_used`; a router failure or empty text is `ok:false` with the error; `SELF_HEALING_TRIAGE_TOOLS_ENABLED=false` restores the single-shot call.
TEST: same suite — "bounds the loop …", "a router failure or empty text …", "SELF_HEALING_TRIAGE_TOOLS_ENABLED=false …".

AC-7 — Every caller of `spawnTriageAgent` (bridge, reconciler, self-healing routes) is unchanged in contract; their suites stay green.
TEST: `outputs/jest-vtid-04232.log` — `dev-autopilot-bridge`, `self-healing-pre-probe`, `vtid-03843`, `vtid-04017-fix-mode` suites green alongside the new one; `tsc --noEmit` clean (`outputs/tsc-noEmit.log`).

AC-8 — Live: the first triage on staging after this deploys shows an `llm.call.completed` row with `stage=triage`, `service=self-healing-triage` and a `tool_calls > 0` in the gateway log line (`[self-healing-triage] Triage complete … tool_calls=N`).
TEST: not run in this session — triage fires only on a real execution failure or a self-healing report; recorded as the post-merge exercise, not claimed.

OASIS_PROOF: no new topic. The triage report feeds the existing `dev_autopilot.execution.*` / self-healing events unchanged; the tool telemetry lives on the returned report and the gateway log line.
