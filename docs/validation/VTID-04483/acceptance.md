# VTID-04483 — Real health data path for the profile Health tab (behind a flag)

The desktop profile Health tab and the mobile Health page show hardcoded
demo values ("Top 12%", "Top 15%", Sleep 85%, a `Math.random()` streak).
The owner asked to keep them visible for now and prepare the real data for
when membership grows. This adds the read-only data function; the frontend
(`exafyltd/vitana-v1`) reads it only when `VITE_HEALTH_REAL_DATA=true`.

## Acceptance criteria

AC-1: health sharing defaults to private in the gateway visibility map (mirror of the frontend map).
TEST: services/gateway/test/vtid-04483-profile-health-summary.test.ts
AC-2: the function is callable by signed-in members only; no JWT returns NULL.
TEST: services/gateway/test/vtid-04483-profile-health-summary.test.ts
AC-3: a subject without an explicit `vitanaHealth` setting is treated as private.
TEST: services/gateway/test/vtid-04483-profile-health-summary.test.ts
AC-4: no community comparison below 20 members; service and test accounts never count.
TEST: services/gateway/test/vtid-04483-profile-health-summary.test.ts
AC-5: activity logs are owner-only and pillars need consent.
TEST: services/gateway/test/vtid-04483-profile-health-summary.test.ts

Live verification of the applied function is in `outputs/live-verification.md`.
