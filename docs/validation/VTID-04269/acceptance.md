# VTID-04269 — Engine Configuration CRON tables: investigate + honest notice

## Report

Part of the Command Hub Autopilot supervisor-visibility task list named in
VTID-04262's CHANGE LOG row. The Autopilot "Engine Configuration" tab's
"Cloud Scheduler CRON Jobs" table renders 10 hardcoded rows
(`cronJobs` array in `renderAutopilotEngineView`) — verified byte-for-byte
matching (schedule + timezone) against `scripts/setup-cloud-scheduler.sh`'s
own `AP_ID|NAME|SCHEDULE|TZ` job list. No gateway route or DB table backs
this table with a live query.

Investigated whether a reliable live source exists to wire up instead, per
this task's own brief. None does: GCP Cloud Scheduler exposes no listing
API this gateway calls anywhere, and — read directly from CLAUDE.md §1 and
the 2026-08-18 VTID-03676 CHANGE LOG row — GCP billing on the project this
script targets by default (`lovable-vitana-vers1`) was disabled
2026-08-16, and only the `push-dispatch` job has a confirmed AWS
EventBridge replacement. Whether these 10 `AP-*` jobs are still actually
firing on any schedule is therefore unconfirmed, and the table gave no
indication of that — it read as ordinary, trustworthy live configuration.

This is the exact defect shape VTID-04064 already fixed elsewhere in this
file (`buildGcpStaticViewDisabledNotice()`, for views showing fabricated
GCP-era infrastructure data). Applied here as an inline notice above the
table rather than replacing the whole view, since the schedule data still
has genuine reference value as documentation even though it can no longer
be trusted as confirmed live status.

## Acceptance Criteria

AC-1 — The CRON Jobs card shows a clearly-labelled static-data notice,
rendered before the table itself.
TEST: services/gateway/test/vtid-04269-engine-config-cron-notice.test.ts — "renders a static-data notice inside the CRON Jobs card, before the table is built".

AC-2 — The notice states plainly that this is static data (not a live
query) and names the source script (`scripts/setup-cloud-scheduler.sh`).
TEST: services/gateway/test/vtid-04269-engine-config-cron-notice.test.ts — "the notice discloses that this is static data, not a live query, and names the source script".

AC-3 — The notice also discloses the specific reason the data can't be
trusted as live (GCP Cloud Scheduler billing disabled, unconfirmed AWS
migration) rather than a vague generic disclaimer.
TEST: services/gateway/test/vtid-04269-engine-config-cron-notice.test.ts — "the notice discloses the GCP billing/migration status, not just a generic disclaimer".

AC-4 — The new notice element uses a CSS class, not inline
`.style.cssText` (the CSP Governance Gate's `\.style\b` check).
TEST: services/gateway/test/vtid-04269-engine-config-cron-notice.test.ts — "uses a CSS class, not inline .style.cssText, for the new notice element" (also verified directly against the CSP gate, see commands.log).

AC-5 — The CRON job reference data itself (`cronJobs` array — the actual
`AP-ID`/schedule/timezone values) is untouched; this VTID adds a notice,
it does not rewrite or remove the reference data.
TEST: services/gateway/test/vtid-04269-engine-config-cron-notice.test.ts — "the CRON job data itself is untouched — this is a notice ADDED, not a data rewrite".

AC-6 — `.autopilot-static-cron-notice` is a real CSS class defined in
`styles.css` (not an undefined className producing invisible/unstyled
text).
TEST: services/gateway/test/vtid-04269-engine-config-cron-notice.test.ts — ".autopilot-static-cron-notice is defined in styles.css".

AC-7 — The Command Hub's cache-bust marker on `index.html` is bumped for
`app.js`, `styles.css`, and `index.html` share the identical marker
string, per CLAUDE.md §16 IF-THEN 25.
TEST: services/gateway/test/vtid-04269-engine-config-cron-notice.test.ts — "the Command Hub cache-buster on index.html was bumped for this change" (also re-asserted by the pre-existing services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts).

AC-8 — `scripts/ci/command-hub-ownership-guard.js`'s `ALLOWED_VTID_PATTERN`
recognizes this VTID (branch `claude/vtid-04269-engine-config-cron-notice`,
PR title carrying `VTID-04269`).
TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts — full file (pre-existing, generic pin — re-run green after the allowlist addition; also verified directly, see commands.log).

## OASIS Impact

None. Pure Command Hub frontend UI change — no route, no schema, no OASIS
event.
