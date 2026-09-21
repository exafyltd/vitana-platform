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
