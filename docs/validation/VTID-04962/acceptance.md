# VTID-04962 — acceptance

AC-1 An FCM error other than an invalid/unregistered token is reported as `'error'`, not as a send, and does not revoke the token.
TEST: services/gateway/test/vtid-04962-push-outcome.test.ts ("a credentials / permission error is an error, not a send", "counts only accepted sends; an error neither counts nor revokes")

AC-2 With FCM failing and no deep link, notifyUser() falls back to Appilix; with FCM delivering, no Appilix push is sent (no duplicate).
TEST: services/gateway/test/vtid-04962-push-outcome.test.ts ("FCM credentials broken → Appilix fallback fires and the outcome is recorded", "FCM delivers → no Appilix push (no duplicate) and delivered_fcm")

AC-3 POST /push-dispatch records the right push_outcome at every call site, and writes push_sent_at before the outcome for every row.
TEST: services/gateway/test/vtid-04962-push-dispatch-outcome.test.ts

AC-4 A failed outcome write never fails a notification; push_sent_at is still set at insert time in notifyUser().
TEST: services/gateway/test/vtid-04962-push-outcome.test.ts ("a failed outcome write never fails the notification", "push_sent_at is still set at insert time")

AC-5 /ops/health/push-dispatch reports outcome counts and turns degraded (fcm_send_errors) only when FCM errors exceed half of ≥20 FCM attempts; without outcomes it behaves as before.
TEST: services/gateway/test/vtid-04962-push-health.test.ts, services/gateway/test/vtid-04663-ops-health-checks.test.ts

AC-6 Migration 20261007190000 is additive, idempotent, transactional and parses as Postgres.
TEST: scripts/ci/pr-gate/gate.mjs migrations (lint) + libpg-query parse (outputs/local-checks.txt)

OASIS_IMPACT: no new OASIS topics or event shapes.
