# VTID-04430 — Support tickets carry the app version

`VITE_APP_VERSION` was read by the member ticket form and product analytics but
set by no workflow, `.env` or Vite config, so `feedback_tickets.app_version` was
null on every ticket. Brief §3.2 asks a ticket to carry the app version.

AC-1: Stage, prod and preview frontend builds write the checked-out commit as
VITE_APP_VERSION; `index.html` exposes it as `<meta name="vitana-app-version">`
(exafyltd/vitana-v1, same VTID).
TEST: src/lib/app-version-stamp.test.ts (exafyltd/vitana-v1)

AC-2: The ORB widget reads that meta tag and sends `app_version` on session
start; the session stores it only when it is a short plain token.
TEST: services/gateway/test/vtid-04430-ticket-app-version.test.ts

AC-3: report_to_specialist writes it to `feedback_tickets.app_version`.
TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts

AC-4: The typed submit_* tools forward it on the routed path and write it on the
unrouted path.
TEST: services/gateway/test/orb-tools/feedback-settings-tools.test.ts

OASIS_PROOF: no new OASIS topic; the value lands on the existing ticket row.
