# VTID-04056 — Dev Autopilot execution d93d5bce

## Report

Automated execution of the approved plan for VTID-04056 (finding `76df060e-99af-4dc3-b947-1e7782bf36c9`, plan v1).
The model's own description of the change is in the pull request body; the
`commands.log` next to this file records what the executor did and which model served it.

## Acceptance Criteria

AC-1 — `services/gateway/src/index.ts` is modified as the plan describes, compiles under `npm run build`, and the gateway test suite stays green.
TEST: services/gateway full jest suite in CI (`npm test`) — no paired test file for services/gateway/src/index.ts is part of this diff; coverage relies on the existing suite.

AC-2 — `services/gateway/src/middleware/command-hub-backup-denylist.ts` is created as the plan describes, compiles under `npm run build`, and the gateway test suite stays green.
TEST: services/gateway full jest suite in CI (`npm test`) — no paired test file for services/gateway/src/middleware/command-hub-backup-denylist.ts is part of this diff; coverage relies on the existing suite.

AC-3 — `services/gateway/test/command-hub-backup-file-denylist.test.ts` is created as the plan describes, compiles under `npm run build`, and the gateway test suite stays green.
TEST: services/gateway/test/command-hub-backup-file-denylist.test.ts — new/updated assertions in this diff run in CI (`npx jest services/gateway/test/command-hub-backup-file-denylist.test.ts`).

## Route mount evidence

This PR's only new `app.use(...)` call is a deny-list MIDDLEWARE, not a new
route with its own success response — it never adds a URL that didn't exist
before. It changes the response the FIVE ALREADY-EXISTING stale static paths
give (200 file → 404 JSON), while every other `/command-hub/*` path is
unaffected.

ROUTE_MOUNT: `app.use('/command-hub', denyCommandHubBackupFiles)` in
`services/gateway/src/index.ts`, mounted immediately before the pre-existing
`app.use('/command-hub', express.static(staticPath, ...))` — no new route
registration, no change to the existing `commandHubRouter` mount.

FINAL_URL: `https://gateway.vitanaland.com/command-hub/app.js.backup` (and
the other four denied paths: `app.js.backup2`, `index.html.backup`,
`index.html.backup-20251108-223919`, `debug.html`) — each now 404s instead
of serving the file; `https://gateway.vitanaland.com/command-hub/app.js` and
`/index.html` are unaffected (still 200).

CURL_PROOF: not available from this sandbox (no network path to a live
gateway, and probing production speculatively is against this repo's own
rules). The equivalent evidence that IS available — a real Express app,
over the actual repo's `services/gateway/src/frontend/command-hub/`
directory, mounting `denyCommandHubBackupFiles` before `express.static` —
is exercised as an HTTP-level regression test in
`test/command-hub-backup-file-denylist.test.ts` ("mount-order regression"
case): all five stale files 404, `app.js`/`index.html` still 200 and
non-empty; a sibling "baseline proof" case asserts all five files 200
under `express.static` ALONE (no middleware), proving the files really
exist on disk and the leak was real before this fix. Post-merge, curl the
FINAL_URLs above against staging (`preview-aws-gateway.vitanaland.com`)
once `AWS-STAGE-DEPLOY-GATEWAY.yml` rolls this commit; production only
after PUBLISH.
