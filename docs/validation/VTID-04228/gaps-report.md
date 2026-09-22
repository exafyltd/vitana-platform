# VTID-04228 — gaps reported, not silently fixed (item 5 of the 2026-09-21 brief)

## 5a. `dev_autopilot_config` on the live DB (read-only, 2026-09-21)

| column | value |
|---|---|
| kill_switch | **false** |
| auto_approve_enabled | **false** |
| daily_budget / concurrency_cap / cooldown_minutes | 500 / 4 / 1 |
| auto_approve_max_effort / risk classes | 8 / [low, medium] |
| auto_approve_scanners | 11 ids (todo, npm-audit, dead-code, missing-tests, large-file, route-auth, rls-policy, schema-drift, safety-gap, secret-exposure, stale-feature-flag) |
| auto_approve_impact_enabled / rules | true / 5 rules |
| allow_scope / deny_scope | VTID-04005 widened list / unchanged |

Consequence: the kill switch is OFF, but `autoApproveTick()` returns at its
second guard (`if (!cfg.auto_approve_enabled) return;`,
`dev-autopilot-execute.ts`), so **nothing is ever auto-approved** — every
scan-produced finding stops at `status='new'` after `lazyPlanTick` plans it.
This row is shared by prod and staging (one Supabase project), so flipping
it is a decision that reaches both gateways at once; not flipped here.

## 5b. `architecture-investigator.ts` calls DeepSeek directly

`callDeepSeek()` POSTs to `${DEEPSEEK_BASE_URL}/chat/completions` with
`DEEPSEEK_API_KEY`, model `ARCH_INVESTIGATOR_MODEL || 'deepseek-flash'`,
and writes `llm_provider:'deepseek'` into `architecture_reports` itself.
It bypasses `callViaRouter`: no `llm_routing_policy` stage, no
`llm.call.started/completed` OASIS events (so it is invisible to the cost
telemetry every other stage has), no policy-driven fallback, and a hard
throw when the key is absent (prod's task def has DEEPSEEK_API_KEY as a
plain env var; staging as a secret).

Proposed fix (not applied — asking first):
1. Replace `callDeepSeek(prompt)` with
   `callViaRouter('triage', prompt, { systemPrompt: SYSTEM_PROMPT, maxTokens: 4096, temperature: 0.2 })`
   — `triage` is the stage the sibling advisory agent
   (`self-healing-triage-service.ts`) already uses, and its v17 policy is
   Bedrock Sonnet 4.6 primary (rule 10a). If DeepSeek is wanted for this
   agent specifically, keep it as a per-call override
   (`providerOverride:'deepseek', modelOverride:'deepseek-flash'`, VTID-03820
   semantics) so the policy's fallback still applies.
2. Persist `r.provider` / `r.model` / `r.usage` into `architecture_reports`
   (`llm_provider`, `llm_model`, `prompt_tokens`, `completion_tokens`)
   instead of the hardcoded `'deepseek'` + module constant.
3. Drop `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `ARCH_INVESTIGATOR_MODEL`
   from this module; the adapter owns credentials.
4. Tests: update `architecture-investigator` suites to mock `callViaRouter`
   and assert the emitted `llm.call.*` events carry `stage:'triage'`.
Decision needed: stage `triage` (recommended) vs. a new `investigator`
stage in `llm_routing_policy` (needs a policy version + Command Hub row).

## 5c. `AUTOPILOT_LOOP_ENABLED` (autopilot-event-loop, VTID-01179)

Unset on both live task defs (rev 489 staging, rev 114 prod), so
`initializeEventLoop()` logs "Event loop disabled by configuration" and
returns. What it gates today: ONLY the OASIS-event-driven state machine in
`autopilot-event-loop.ts` (`autopilot-event-mapper.ts` transitions:
`recommendation.activated`, `self-healing.task.injected` /
`autopilot.task.spec.created` with `meta.auto_approved && source==='self-healing'`,
`vtid.lifecycle.execution_approved`, legacy `vtid.lifecycle.allocated`…)
whose `dispatch` action hands the VTID to the **worker-orchestrator /
worker-runner** plane.

Do self-healing `spec.created` events need it? **Not for the Dev Autopilot
path.** `self-healing-injector-service.ts` step 3b
(`bridgeToAutopilotExecution`) writes a `dev_autopilot_executions` row
directly for every auto-approved (non-voice-synthetic) diagnosis, and
`backgroundExecutorTick` claims that row with no event-loop involvement;
the `autopilot.task.spec.created` event is the legacy signal for the
worker-runner plane, which the loop would only re-dispatch. Live evidence:
5 `autopilot.task.spec.created` events in 30 days, 0 event-loop
transitions, and the reconciler (`self-healing-reconciler.ts`, default on)
re-drives stale `self_healing_log` rows on its own. Leave it unset; enabling
it would double-dispatch auto-approved self-healing VTIDs to worker-runner
(which VTID-03516's allowlist would then claim) alongside the executor.

## 5d. Found on the way (not in the brief)

- **No `planner`-stage LLM call in 14 days** (`oasis_events` by stage):
  `lazyPlanTick → generatePlanVersion → callViaRouter('planner')` never ran
  because no executable-source-type finding existed to plan — the scan was
  404ing. The live planner policy (v17) is **Opus 4.5 primary, Sonnet 4.6
  fallback**, not "Sonnet 4.6" as the brief assumed.
- `GET /api/v1/test-contracts/missing` is a read-only listing; scheduling
  it produces no rows. A row-producing sweep would mint VTIDs and is an
  owner decision (see VTID-04226 pack).
- Prod promotion of the loop additionally needs `DEV_AUTOPILOT_SCAN_TOKEN`
  and `GATEWAY_INTERNAL_TOKEN` on the prod task def (neither is there; both
  deliberately staging-only in VTID-04225/04226).
- The session IAM user (`claude-code-aws-agent`) has no `scheduler:*`,
  `lambda:*`, `iam:*` — the EventBridge apply is owner-run.

## 5e. Found by the live run itself (2026-09-21 15:21–15:40 UTC, staging) — reported, not fixed

Three defects the scan → plan leg exposed the first time it ran against a
live host. All three are real; none is in the brief's scope, so each is
recorded with the live evidence and a proposed fix rather than patched in
this PR.

### 5e-1. The same finding is planned up to 10 times concurrently (41 planner calls for 9 plan rows)

`oasis_events` `llm.call.completed` per VTID: `VTID-DA-FIND-9e1bdb97` 10
calls, `23e083d1` 8, `efec84e4` 8, `b0aa6815` 5, `e8cb7fae` 5, `b869c955` 3
(which is how it got a `plan.version_added` v2 nobody asked for). Two
producers race: the post-scan eager planner (`eagerlyPlanTopK`, K=5,
fire-and-forget from `ingestScan`) and `lazyPlanTick` every 30 s, while a
single `generatePlanVersion` takes 20–40 s plus one "lacks test files"
retry. `lazyPlanTick`'s "plan already exists" check happens BEFORE the
generation it is racing, and its in-flight guard reads
`dev_autopilot_worker_queue` (`kind=plan`, `pending/running`) — which stayed
at 0 rows the whole time, because planning is inline, not queued. The
VTID-03579 backoff only covers FAILED generations; a slow successful one is
invisible to every guard. Cost at Opus 4.5 list price for this one scan:
302,556 in + 63,445 out ≈ $9 for work that needed ≈ $2.
Proposed fix: an in-process `Set<findingId>` of generations in flight
(checked and set inside `lazyPlanTick` and `eagerlyPlanTopK`, cleared in
`finally`), plus a `dev_autopilot_plan_versions` unique index on
`(finding_id, version)` so a second concurrent v1 fails at the DB instead
of landing as v2. One instance per env today, so the in-process set is
sufficient; the index is the belt.

### 5e-2. `dev_autopilot_runs` never finalizes — the run row still says `ingesting`

`run_id=cf77d23c…` has `status='ingesting'`, `new_finding_count=0`,
`completed_at=NULL` (re-read 15:40 UTC) while the
`dev_autopilot.scan.completed` event at 15:21:19.883 says "15 new, 0
updated". The finalize PATCH in `dev-autopilot-synthesis.ts` (step 4,
`status:'done'`) has no `.ok` check and logs nothing on failure; `'done'`
IS allowed by the table's CHECK constraint, so the failure is in the
request itself, not the value. Any dashboard or scanner-health check
reading `dev_autopilot_runs` sees every scan as still running.
Proposed fix: check the PATCH result, log + emit `dev_autopilot.scan.failed`
on a non-ok, and add a test that the finalize body is what lands.

### 5e-3. Planner cost is reported as $0

Every `llm.call.completed` row carries `cost_estimate_usd: 0` because
`MODEL_COSTS` in `constants/llm-defaults.ts` has no key for the Bedrock
inference-profile id `eu.anthropic.claude-opus-4-5-20251101-v1:0` (nor
`eu.anthropic.claude-sonnet-4-6`); `estimateCost` falls through to 0.
VTID-04031 solved exactly this for the Operator Console
(`pricingKeyForModel` strips the `eu.`/`global.` profile prefix) but only
on that surface. The autopilot's daily budget (`dev_autopilot_config.daily_budget`
500) is therefore never consumed by planner calls.
Proposed fix: apply `pricingKeyForModel` inside `estimateCost` (or the
router's telemetry emitter) so every stage prices Bedrock profiles the same
way.
