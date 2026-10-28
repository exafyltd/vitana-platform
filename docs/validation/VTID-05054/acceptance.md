# VTID-05054 — acceptance criteria (Health Hub WP4b-2 / D5 + D7)

AC-1 AP-0607 (`runLabReportIngestion`) no longer tells the member a lab report "is being analyzed" and no longer emits `health.biomarkers.stored` (no parser exists, so AP-0608 would start on nothing). It returns `{usersAffected: 0, actionsTaken: 0}`.
TEST: npx jest test/vtid-05054-lab-notice-and-webhook-purge.test.ts -t "AP-0607"

AC-2 `connector_webhooks_log` keeps 90 days: the purge deletes only rows with `received_at` older than the cutoff.
TEST: npx jest test/vtid-05054-lab-notice-and-webhook-purge.test.ts -t "deletes only rows older than 90 days"

AC-3 The purge is off unless `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED` is exactly `true`; the staging deploy workflow never sets it (staging shares the production database); `index.ts` schedules it only behind the flag.
TEST: npx jest test/vtid-05054-lab-notice-and-webhook-purge.test.ts -t "flag|staging deploy workflow|index.ts"

AC-4 No regression in the automation handler suites; the gateway type-checks.
TEST: npx jest test/automation-role-targeting.test.ts test/services/automation-handlers-phase1-batch4.test.ts test/services/memory/diary.test.ts test/vtid-04349-automation-shadow.test.ts; npx tsc --noEmit -p .

OASIS_PROOF: AP-0607 emits `health.lab_report.parse_unavailable` (status info, vtid VTID-05054); each purge run emits `connector.webhook_log.purged` (info with the deleted count and cutoff, or error with the message). Both types are in `CicdEventType`; both emissions are asserted in the test above.
TEST: npx jest test/vtid-05054-lab-notice-and-webhook-purge.test.ts -t "OASIS"
