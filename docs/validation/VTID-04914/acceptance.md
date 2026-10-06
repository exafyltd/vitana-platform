# VTID-04914 — calendar loops and the Google sync switch on in production

Owner decision 2026-10-06 ("Turn on Google Sync, activate for production").
Plan: `plan-sparring.md` (converged, 3 rounds, plan hash `e64911d9c6d0734acc94b829b02e0991ac172df64b28a7895bebc46b6f06ac38`).
Not part of this VTID: creating the Google OAuth client and its secrets (operator-only), the production promotion itself.

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: none (deploy workflows + tests + docs).

FINAL_URL: n/a (task-definition pins; take effect on the next deploy).

CURL_PROOF: STAGING-VERIFY `GET /api/v1/calendar/google` → 401 JSON (route mounted, unsigned caller refused); see staging-tests.json.

OASIS_PROOF: n/a (no state change in this PR).

## Acceptance criteria

AC-1: The production gateway workflow pins CALENDAR_DEFAULT_REMINDERS_ENABLED, CALENDAR_MAINTENANCE_ENABLED and CALENDAR_GOOGLE_SYNC_ENABLED to "true", exactly once each, keeping every other variable, in its own step before the final register step.
  TEST: services/gateway/test/vtid-04914-calendar-prod-gates.test.ts
AC-2: The Google OAuth client is wired in production only when both repository variables (full secret ARNs) are set; one or none set produces no secret reference (never a dangling valueFrom).
  TEST: services/gateway/test/vtid-04914-calendar-prod-gates.test.ts
AC-3: Staging pins CALENDAR_GOOGLE_SYNC_ENABLED=true next to the two calendar loops it already pinned.
  TEST: services/gateway/test/vtid-04914-calendar-prod-gates.test.ts
AC-4: The older calendar suites record the new decision (pinned on staging and production) and still pass; without a Google client the sync reports not_configured.
  TEST: services/gateway/test/vtid-04372-calendar-google-sync.test.ts
AC-5: Every run: step in both deploy workflows is valid bash and under GitHub's 20,000-character limit.
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts
