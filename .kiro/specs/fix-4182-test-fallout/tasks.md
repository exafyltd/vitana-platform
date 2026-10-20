# Tasks — fix-4182-test-fallout
Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval (one per lane).

<!-- lane: staging-test-05082 -->
## staging-test-05082 — point the VTID-05082 suite at svg-preview.js (repo vitana-platform)
Allowed paths:
- `docs/validation/VTID-05082/staging-tests.json`
- `docs/validation/<VTID>/**` (the lane's own record and staging suite, rule 47)

- [ ] A1. In `docs/validation/VTID-05082/staging-tests.json`, test #3: set `path` to
  `/command-hub/svg-preview.js?v=20261121-vtid-05082` and `name` to "deployed svg-preview.js contains the SVG
  sanitizer/renderer", and update `reason` to name `svg-preview.js`. Keep `expect_status: 200` and
  `expect_body_contains: "sanitizeSvgMarkup"`. Leave tests #1 and #2 unchanged.
- [ ] A2. Same file: update `note` to say the renderer lives in `svg-preview.js` (loaded by `index.html`), not `operator-console.js`.
- [ ] A3. `docs/validation/<VTID>/staging-tests.json`, read-only, modelled on `docs/validation/VTID-05236/staging-tests.json`:
  GET `/alive` returns 200, and GET `/command-hub/svg-preview.js?v=20261121-vtid-05082` returns 200 and contains `sanitizeSvgMarkup`.
  Record the commands in `commands.log`.

Acceptance:
- Both JSON files parse (`node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`).
- A read-only GET of `https://preview-aws-gateway.vitanaland.com/command-hub/svg-preview.js?v=20261121-vtid-05082`
  returns 200 and the body contains `sanitizeSvgMarkup`.
- The diff touches only the allowed paths.
- Docs-only: no staging deploy, no Gate 2. Merges before `jest-05077-cachebuster`; the STAGING-VERIFY run of the next
  gateway deploy containing this fix (normally that lane's merge) is the proof, recorded in this lane's log.
<!-- lane: staging-test-05082 -->

<!-- lane: jest-05077-cachebuster -->
## jest-05077-cachebuster — update the stale app.js pin in the VTID-05077 test (repo vitana-platform)
Allowed paths:
- `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts`
- `docs/validation/<VTID>/**` (the lane's own record and staging suite, rule 47)

- [ ] B1. At `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212`, change
  `expect(html).toContain('/command-hub/app.js?v=20261120-vtid-05148');` to
  `expect(html).toContain('/command-hub/app.js?v=20261121-vtid-05082');`. No other line changes.
- [ ] B2. `docs/validation/<VTID>/staging-tests.json`, read-only: GET `/alive` returns 200, and GET `/command-hub/index.html`
  returns 200 and contains `/command-hub/app.js?v=20261121-vtid-05082`. Record the Jest command and its result in `commands.log`.
- [ ] B3. Before opening the PR, check #4207 (`gateway-test-cachebust/fix-pin`). If it has already fixed `:212` on
  `main`, B1 is an empty diff: record that in the lane log and hand the lane back as done, with no PR.
- [ ] B4. Open the PR only after `staging-test-05082` has merged, so this lane's staging deploy carries the
  corrected VTID-05082 manifest and its STAGING-VERIFY run proves both lanes.

Acceptance:
- `cd services/gateway; npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts` passes.
- The lane's `staging-tests.json` parses as JSON.
- The diff touches only the allowed paths.
<!-- lane: jest-05077-cachebuster -->
