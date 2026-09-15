# VTID-03901 — Acceptance

Partner health test result-ready notifications must reach the lock screen
(push), not only the in-app notification center. `ingestPartnerResult()`
was reusing the in-app-only `lab_report_processed` type for this moment.

AC-1: `health_test_result_ready` exists in `TYPE_META`
(`services/gateway/src/services/notification-service.ts`) with
`channel: 'push_and_inapp'`, `priority: 'p1'`, `category: 'health'`.
TEST: outputs/type-meta-entry.txt (grep of the added TYPE_META line)

AC-2: `ingestPartnerResult()` (`services/gateway/src/services/partner-health/ingestion.ts`)
notifies the user with the `health_test_result_ready` type on a successful
result, not `lab_report_processed`.
TEST: services/gateway/test/partner-health/ingestion.test.ts — "projects a
valid result into lab_reports/biomarker_results, flips status, notifies,
and emits result_ready" asserts
`notifyUserAsync` is called with `'health_test_result_ready'`.

AC-3: The two sibling notification types this change must NOT touch stay
exactly as they were: `partner_test_status_changed` (intermediate
ordered/sample_received/processing pings) stays `channel: 'inapp'`, and
`lab_report_processed`'s other caller
(`services/gateway/src/services/automation-handlers/health-wellness.ts`'s
"report received, still being analyzed" ping) is unmodified.
TEST: outputs/sibling-types-diff.txt (full diff of notification-service.ts,
showing only the new entry + comment rewrite, no other TYPE_META row
changed) — health-wellness.ts has zero changes in this PR's diff.

AC-4: No `user_notifications` schema/migration change is required — the
`type` column is a plain `TEXT NOT NULL` column with no CHECK constraint or
enum restricting values.
TEST: outputs/user-notifications-type-column.txt (grep of the column
definition across the two notification-system migrations)

AC-5: No i18n change needed — the notification copy
(`notif.partner_test_result_ready.title`/`.body`) was already correct
under VTID-03885; this fix only changes which notification *type* (hence
channel) the copy is delivered through.
TEST: outputs/tt-call-unchanged.txt (diff hunk around the `notifyUserAsync`
call shows only the type-string argument changed, not the `tt(...)` calls)
