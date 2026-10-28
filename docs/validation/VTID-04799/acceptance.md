# VTID-04799 — Jev P2 B3: self-healing pre-triage cause class, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 B3 (P2). Extends the B1/B2 gates (VTID-04759) in
`jev/gates/selfheal-gates.ts`. Uses the existing `ops_error_triage` decision (VTID-04473) unchanged.

Evidence (plan §10.4 B): 2,855 `llm.call.failed`, 1,050 of them self-healing triage retrying one outage.
B2 already owns provider failures; B3 asks, for every other incident, what kind of error it is before the
triage LLM call is spent.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Gate `selfheal_pretriage` (`JEV_SELFHEAL_PRETRIAGE_MODE`, exact values; anything else off). Off asks and writes nothing, and B1/B2 behave exactly as before.
  TEST: services/gateway/test/vtid-04799-selfheal-pretriage.test.ts
  TEST: services/gateway/test/vtid-04759-selfheal-jev-gates.test.ts
AC-2: In shadow, an incident that B2 does not class as a provider failure, with failure text, is sent to `ops_error_triage` (service = the failing endpoint, topic = triage mode, message = the failure text). One `jev_shadow_decisions` row per triage (subject = the triage VTID) with cause and needs-human. Provider failures and incidents with no text are never asked.
  TEST: services/gateway/test/vtid-04799-selfheal-pretriage.test.ts
AC-3: Enforce (not pinned anywhere) skips triage only for a decided "transient"; an abstained verdict, another cause or an unavailable Jev lets triage run.
  TEST: services/gateway/test/vtid-04799-selfheal-pretriage.test.ts
AC-4: Agreement comes from triage's own parsed report: Jev "transient" agrees with an info-severity report, any other cause with warning/critical. A failed or skipped triage records the outcome with agreed = null. The write-back runs after the report is parsed, never awaited.
  TEST: services/gateway/test/vtid-04799-selfheal-pretriage.test.ts
AC-5: Both gateways pin `JEV_SELFHEAL_PRETRIAGE_MODE=shadow`, never enforce; generated pins agree.
  TEST: services/gateway/test/vtid-04799-selfheal-pretriage.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/gates/selfheal-gates.ts (B3 in the existing gate run)
- services/gateway/src/services/self-healing-triage-service.ts (report write-back)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04799-selfheal-pretriage.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04799/**

## OASIS

OASIS_IMPACT: none new. Each check emits the existing `jev.decision.*` event (source `jev:gate:selfheal_pretriage`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_SELFHEAL_PRETRIAGE_MODE=shadow`. Triage runs exactly as before.
