# VTID-04754 — Jev P0 foundation (follow-up to VTID-04473)

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10 (P0). Owner hand-over 2026-09-30.
No production caller uses any Jev decision yet; this PR builds the
foundation every caller will go through.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: Production declares Jev itself: `AWS-PROD-DEPLOY-GATEWAY.yml` step 2/2 pins the secret ARN (`JEV_SECRET_ARN`) and upserts `TYPESAFE_API_KEY` (secret reference) and `JEV_DECISIONS_ENABLED=true` after the `GITHUB_SAFE_MERGE_TOKEN` block and before `env_overrides`; `JEV_COMMUNITY_ENABLED` is never set.
  TEST: services/gateway/test/vtid-04754-jev-prod-workflow.test.ts
  TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts
AC-2: The staging probe keeps the AWS error and logs "not found", "access denied" and other failures separately (no more `2>/dev/null`).
  TEST: services/gateway/test/vtid-04754-jev-prod-workflow.test.ts
  TEST: services/gateway/test/vtid-04473-jev-staging-wiring.test.ts
AC-3: Caller role uses `pickEffectiveRole` (role_preferences → user_tenants.active_role), must be in the tenant's permitted set (mirror of `get_my_permitted_roles`: grants ∪ active memberships ∪ community), falls back to the primary `user_tenants` tenant when the JWT has none, accepts an acting role only when permitted, fails closed when the permitted set cannot be read, and reports a Cognito token as `identity_gaps: ['cognito_exafy_admin_unresolved']`.
  TEST: services/gateway/test/vtid-04754-jev-foundation.test.ts
  TEST: services/gateway/test/routes/jev-decisions.test.ts
AC-4: exafy_admin has no tenant unless one is named (header `x-jev-tenant`, query or body `tenant_id`; uuid or slug); tenant-scoped decisions without it answer 400 `target_tenant_required`; an unknown tenant is 404; a named-tenant call is recorded with actor, tenant and `cross_tenant: true`. A normal user naming another tenant gets 403.
  TEST: services/gateway/test/vtid-04754-jev-foundation.test.ts
  TEST: services/gateway/test/routes/jev-decisions.test.ts
AC-5: Every decision declares `planes` and a `data` class; the policy allows telemetry/business on the internal plane, refuses phi on every plane, keeps the patient plane off, applies member rules (env flag + tenant plane + budget) to member content whoever calls, lets Community Autopilot run telemetry only, and needs the tenant flag for partner_org.
  TEST: services/gateway/test/vtid-04754-jev-foundation.test.ts
  TEST: services/gateway/test/vtid-04473-jev-access-pii.test.ts
AC-6: `tenant_settings.feature_flags.jev = {enabled, planes[], monthly_budget_usd}` is enforced before every call (absent → internal default; malformed or unreadable → fail closed); an exhausted budget falls back with 429 and a `jev.decision.fallback` event; spend is persisted per tenant × plane × month via `jev_record_spend`, platform telemetry under the all-zero tenant id.
  TEST: services/gateway/test/vtid-04754-jev-foundation.test.ts
  TEST: services/gateway/test/vtid-04473-jev-decision-service.test.ts
AC-7: Shadow framework: `JEV_<GATE>_MODE` takes exactly off|shadow|enforce (anything else = off); off makes no call; shadow and enforce record a `jev_shadow_decisions` row next to the system action; enforce is true only on a confident decision.
  TEST: services/gateway/test/vtid-04754-jev-foundation.test.ts
AC-8: `GET /api/v1/jev/admin/stats` adds the persisted month spend, the per-gate shadow agreement and the gate switches; the Command Hub card `/command-hub/jev.html` shows them, is CSP-compliant and leaves the sidebar, `app.js` and `index.html` untouched.
  TEST: services/gateway/test/routes/jev-decisions.test.ts
  TEST: services/gateway/test/command-hub/vtid-04754-jev-card.test.ts

## Scope

SCOPE_ALLOWLIST:
- .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml
- supabase/migrations/20261001100000_vtid_04754_jev_spend_and_shadow.sql
- services/gateway/src/services/jev/**
- services/gateway/src/routes/jev-decisions.ts
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/src/frontend/command-hub/jev.{html,js,css}
- scripts/ci/command-hub-ownership-guard.js (allowlist entry only)
- services/gateway/test/** (Jev suites)
- DATABASE_SCHEMA.md, docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04754/**

## Route mount

No new route file. Existing mount unchanged:
ROUTE_MOUNT: services/gateway/src/index.ts — `mountRouterSync(app, '/api/v1', jevDecisionsRouter, { owner: 'jev-decisions' })`
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/jev/admin/stats (also /api/v1/jev/decisions, /command-hub/jev.html)
CURL_PROOF: unauthenticated GETs must answer `401 application/json` (staging-tests.json); the card page `200 text/html`.

## OASIS

OASIS_IMPACT: no new event type. `jev.decision.*` payloads gain `data`, `cross_tenant` and `identity_gaps`; budget exhaustion and an unreadable tenant flag now emit `jev.decision.fallback` with the reason (`tenant_budget_exhausted`, `tenant_config_unavailable`, `budget_check_failed`). Policy refusals emit nothing (no spend happened), same as access denials.

## Contract changes (on purpose)

- Plane `community` is now `member`; `patient` has its own plane (`patient_plane_off`).
- `moderation_severity` sends member content, so it is off until the member plane is opened for a tenant (no production caller existed).
- Business decisions need a tenant; exafy_admin must name one.

## Database

MERGE_PAYLOAD_PREVIEW: migration `20261001100000_vtid_04754_jev_spend_and_shadow.sql` — two new tables (`jev_spend_counters`, `jev_shadow_decisions`) and three functions (`jev_record_spend`, `jev_shadow_gate_stats`), service role only, RLS on with no client policies. Additive; nothing existing is altered. Applied 2026-10-01 (the drift gate requires it before merge); verification in outputs/migration-applied.txt.

## Not verified live

A live decision with the new gate runs on staging only, after deploy (a decision writes an OASIS event).
