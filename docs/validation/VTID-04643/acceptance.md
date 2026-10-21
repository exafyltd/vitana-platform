# VTID-04643 — Testing & QA rebuild, phase P4: the Run Tests launcher

## Report

A new Command Hub tab, **Run Tests**, lets an exafy admin start a test
workflow by hand — but only one on a reviewed launch list, and never a deploy.

- `services/testing/test-launcher.ts` holds the launch list, each entry with
  its environment and a one-sentence effect: five development/PR suites
  (TEST-SUITE, both calendar regressions, Aurora i18n, frontend Vitest), three
  staging runs (Playwright E2E read-only, re-run STAGING-VERIFY for the gateway,
  ORB widget monitor) and eight production health checks that only read
  (`ALERT-*` via GET or `ci_*` RPCs, `SMOKE-WELCOME-GREETING`). Owner rule
  2026-09-26: writes happen on staging only; production gets read-only checks;
  deploys go through PUBLISH. Every other manually triggerable workflow is
  listed as not launchable with the reason (deploy, dead host, UI test touching
  production, PR gate, or not yet reviewed as read-only — e.g.
  DAILY-STATUS-UPDATE posts to a chat webhook, EXERCISE-* drive traffic).
- `POST /api/v1/testing/launch` (exafy_admin): validates against the list,
  requires a reason, fills inputs server-side — staging E2E always
  `read_only=true` against the staging community app whatever the body says;
  STAGING-VERIFY pinned to the commit the staging gateway's build-info reports
  (refused when it cannot be read); vitana-v1 needs `FRONTEND_DEPLOY_TOKEN` —
  dispatches on `main`, and records a `testing.run.launched` OASIS event with
  the verified caller (never a body field), environment, reason and inputs.
  `GET /launchable` and `GET /launches` feed the tab.
- Command Hub: Run Tests tab (cards grouped by environment, a reason field per
  card, Playwright project checkboxes for E2E, "Not launchable from here"
  with reasons, recent manual runs). Navigation config, screen inventories and
  the voice navigator catalog updated; tq-* classes only (CSP).

## Acceptance Criteria

AC-1 — The launch list never contains a deploy, lists only read-only checks for production (verified against the workflow files: every non-comment write is a `ci_*` RPC), every listed platform workflow exists and is manually dispatchable, and other manual workflows are shown with the reason they are not launchable.
TEST: services/gateway/test/services/testing/test-launcher.test.ts

AC-2 — Launch refuses anything off the list (incl. deploys) and a missing reason; staging E2E is always read-only against staging; STAGING-VERIFY is pinned to staging's served commit or refused; vitana-v1 needs its token; GitHub failures are 502 with no OASIS record; a launch records the verified caller.
TEST: services/gateway/test/routes/testing-launcher.test.ts, services/gateway/test/services/testing/test-launcher.test.ts

AC-3 — The tab reads the launch list from the gateway (no workflow names typed into the browser), launches only through the gateway route with the reason, shows the not-launchable reasons, no inline styles or innerHTML; the module's tabs are consistent across app.js, navigation-config.js and the inventory.
TEST: services/gateway/test/command-hub/vtid-04643-run-tests-tab.test.ts, services/gateway/test/command-hub/vtid-04642-testing-qa-screens.test.ts

AC-4 — Visually verified on a local harness (real launch list compiled from the source, real catalog, fake dispatch) at 1400×900 and 390×844: 16 cards, a start without a reason shows the server's refusal, a start with a reason shows "started" and appears in recent runs, staging E2E with a project starts, "Not launchable" lists 29 workflows with reasons, no page errors, no horizontal overflow.
TEST: docs/validation/VTID-04643/outputs/harness-shoot.js (screenshots in outputs/)

ROUTE_MOUNT: services/gateway/src/routes/testing.ts, mounted at /api/v1/testing (existing mount, unchanged)
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/testing/launch (also GET /launchable, GET /launches)
CURL_PROOF: curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/testing/suites → 200 application/json; charset=utf-8 (router mounted and live on staging; the new routes answer 401 JSON without auth once deployed — staging-tests.json)

OASIS_PROOF: a launch emits testing.run.launched with the verified caller (never a body field), environment, reason and inputs; a failed dispatch emits nothing. Pinned by services/gateway/test/routes/testing-launcher.test.ts.
