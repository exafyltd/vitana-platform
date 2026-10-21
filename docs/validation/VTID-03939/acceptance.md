# VTID-03939 — Commerce Partner Onboarding Phase 3: a patient's own aggregated health results

## Report

Phase 3 of the platform-owner-approved Commerce Partner Onboarding plan
(`vitana-v1`'s `/patient/*` screens currently 100% mock/placeholder — see the
companion `vitana-v1` PR for the frontend half). This PR is the backend leg
only: a new gateway route a patient's own frontend can call to see their
lab reports + biomarker results aggregated across every partner
org/professional that contributed one.

**Corrects a false premise the plan inherited**: the plan's own text claimed
"aggregation into one table already works end-to-end, it just has no
screen." Investigation found the opposite for the *route* layer — no
gateway GET route reads `lab_reports`/`biomarker_results` for the calling
user at all today. The frontend's `/health/my-biology` page queries
Supabase directly from the client, bypassing the gateway entirely, and
additionally references columns (`report_type`, `title`, `provider_name`,
`processing_status`, `file_path`) that don't exist on the real
`lab_reports` schema — a separate, pre-existing bug this PR does not fix
(flagged to the frontend session instead of silently folded in here).

## Changes

- New `GET /api/v1/patient/health-results` (`services/gateway/src/routes/patient-health-results.ts`),
  mounted at `/api/v1/patient`. Auth: Bearer token → `createUserSupabaseClient(token)`
  (mirrors `POST /health/lab-reports/ingest`'s pattern in `health.ts`) —
  RLS-scoped as the caller, never a service-role client, since this is a
  patient reading their own data, not an org-admin/staff route.
- Queries `lab_reports` (real columns only) joined to `biomarker_results`
  via the FK's reverse embed. For rows with `partner_result_id IS NOT
  NULL`, resolves org attribution via `partner_health_results.order_id →
  partner_health_test_orders.partner_id → partner_registry.display_name`
  (all live on `main` today, via VTID-03885).
- **Degrades gracefully** on `partner_health_test_orders.assigned_professional_user_id`
  and `partner_registry.partner_organization_id → partner_organizations`
  — both only exist once VTID-03932's migration (PR #3331, still unapplied)
  is live. On a "column does not exist" error, retries the narrower column
  list and returns `null` for those two fields rather than failing the
  whole request — same retry-on-schema-cache-error shape
  `fetchLifeCompass()` already uses in `services/user-context-profiler.ts`
  for an identical lagging-migration problem.
- A self-uploaded report (`partner_result_id IS NULL`) gets `org: null`
  unconditionally — that is not a degraded state, it's the correct answer
  (nothing to attribute).

## Acceptance Criteria

AC-1 — 401 with no Bearer token.
TEST: `test/patient-health-results.test.ts` — describe "auth" (1 test).

AC-2 — Happy path returns every lab_reports row the caller owns, each with
its biomarkers, org attribution resolved for partner-sourced rows and
`null` for self-uploaded rows.
TEST: same file — describe "happy path" (2 tests).

AC-3 — A "column does not exist" error on the VTID-03932-only columns
(`assigned_professional_user_id`, `partner_organization_id`) is caught and
retried narrower; the request still returns 200 with the fields resolved
to `null` rather than failing outright. A failure resolving
`partner_health_results` itself also degrades to `org: null`, not a 500.
TEST: same file — describe "graceful degradation" (2 tests) — this is the
one behavior in this PR that's easy to get wrong silently, so it has its
own dedicated coverage per the approved plan's own verification section.

AC-4 — A genuine `lab_reports` query failure (not a missing-column case)
is a real 500, and a `me_context` JWT/auth error is a 401 — errors are
never silently swallowed into a false-positive 200.
TEST: same file — describe "auth context errors" (2 tests).

AC-5 — `tsc` produces no new errors attributable to this route beyond the
sandbox's own missing-`node_modules` noise.
TEST: narrow `tsc --noEmit` run, `outputs/gateway-tsc-narrow.txt` — same
"Cannot find module '@supabase/supabase-js'/'express'"-shaped noise
VTID-03932/VTID-03935's own evidence packs already documented (no
`node_modules` in this sandbox); the two `TS7006` implicit-any lines are a
cascade of that same missing-types root cause (an unresolved
`SupabaseClient` import), not a real typing gap in this file — the two
`orders`/`registryRows` variables both carry explicit type annotations,
and `id`/`o`/`r` would infer correctly once the module resolves.

## Not verified / blocked

Same root cause as VTID-03932/VTID-03935 (same session lineage): no
`npm install` in this sandbox (`registry.npmjs.org` returns `403
Forbidden` on every package tarball, confirmed by trying it directly, not
assumed) — so no `node_modules`, meaning no runnable `jest`, no full-project
`tsc`, no live Supabase call. Every test case above was traced by hand
against the fake-Supabase harness in `test/patient-health-results.test.ts`
line by line, cross-checked against the real query shapes each mocked
table call is meant to exercise. No live Supabase access either way — the
VTID-03932 migration this route's graceful-degradation path is written
against is still unapplied, pending the platform owner's "apply now" on
PR #3331.
