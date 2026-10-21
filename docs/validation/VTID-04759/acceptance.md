# VTID-04759 — Jev P1: self-healing provider-failure type (B2) + incident dedupe (B1), shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 B1/B2, §10.5 P1. Builds on VTID-04754.

Evidence (production `oasis_events`, `llm.call.failed`, 14 days to 2026-10-01):
Bedrock "Operation not allowed" 2,187 (worker 1,570, triage 567); DeepSeek 402
"Insufficient Balance" 634 (triage 483, worker 142); "Too many tokens per day"
18; "prompt is too long" 14. Self-healing triage itself is the largest single
caller after the worker: one outage → one triage per failed execution.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: The provider-failure classifier maps every production failure string to its class and action (credit/permission/quota/executor_unavailable → stop_and_alert; throttle → back_off; transient → retry_once; input_too_large and unknown → triage), names every provider involved, agrees with the retry breaker's `PROVIDER_OUTAGE_RE` on every outage it names, and never classifies a failure of our own endpoints (403/502 without a provider) as a provider failure.
  TEST: services/gateway/test/vtid-04759-selfheal-jev-gates.test.ts
AC-2: The incident key makes one provider outage one incident across executions (`provider:<class>:<providers>`), and keys anything else on the endpoint (else the triage VTID, never deduped).
  TEST: services/gateway/test/vtid-04759-selfheal-jev-gates.test.ts
AC-3: Gate modes: off (default, also any typo) does nothing; shadow records one `jev_shadow_decisions` row per gate and never skips triage; enforce skips triage only for a stop-class provider failure (B2) or the same incident within 30 minutes (B1). A failing gate store never blocks triage.
  TEST: services/gateway/test/vtid-04759-selfheal-jev-gates.test.ts
AC-4: Jev (`ops_error_triage`) is called only for a provider failure the rules do not recognise; its verdict is recorded with the row; known classes cost nothing.
  TEST: services/gateway/test/vtid-04759-selfheal-jev-gates.test.ts
AC-5: The outcome is written back from triage's own result: B2 `agreed` = (gate said stop) == (triage then died on a stop-class failure); B1 records the outcome. Agreement per gate shows on `GET /api/v1/jev/admin/stats` and the Command Hub Jev card.
  TEST: services/gateway/test/vtid-04759-selfheal-jev-gates.test.ts
AC-6: `spawnTriageAgent` runs the gates before the LLM call for every caller (bridge, reconciler, route); a skip returns `ok:false` with `skipped_by_gate`, so callers escalate exactly as on a failed triage. With the gates off, triage is unchanged.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  TEST: services/gateway/test/dev-autopilot-bridge.test.ts
  TEST: services/gateway/test/self-healing-pre-probe.test.ts
AC-7: Staging and production deploy workflows pin both gates to `shadow` (never `enforce`); the generated flag pins agree.
  TEST: services/gateway/test/vtid-04759-selfheal-jev-gates.test.ts
  TEST: services/gateway/test/vtid-04754-jev-prod-workflow.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/gates/selfheal-gates.ts (new)
- services/gateway/src/services/jev/jev-repository.ts (one lookup)
- services/gateway/src/services/self-healing-triage-service.ts (gate call before the LLM; `skipped_by_gate` on the result)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pins)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04759-selfheal-jev-gates.test.ts, services/gateway/test/vtid-04754-jev-prod-workflow.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04759/**

No route, no migration (uses `jev_shadow_decisions` from VTID-04754).

## OASIS

OASIS_IMPACT: none new. A Jev call for unrecognised text emits the existing `jev.decision.*` event (`source=jev:gate:selfheal_provider_failure`). Gate rows live in `jev_shadow_decisions`.

## Going to enforce

Not in this PR. Enforce is a separate change (P2) once `GET /api/v1/jev/admin/stats` shows the gates' agreement rate on real triages. Rollback at any time: set the env to `off`.
