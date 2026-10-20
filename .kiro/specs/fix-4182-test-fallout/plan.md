---
change_class: light
---
# plan(fix-4182-test-fallout): fix staging + jest checks broken by #4182
<!-- plan:begin -->
## Problem
PR #4182 (VTID-05082, squash-merged as `80e2b3553`) left two checks red on `main`. Both are stale test
expectations. The product code is correct in both cases. Premises are checked against `origin/main` @ `e6ed415a9`.

### A. STAGING-VERIFY: the VTID-05082 suite looks for the SVG sanitizer in the wrong file
1. `docs/validation/VTID-05082/staging-tests.json`, test #3 ("deployed operator-console.js contains the SVG
   sanitizer/renderer"), does `GET /command-hub/operator-console.js?v=20261121-vtid-05082` and expects the
   body to contain `sanitizeSvgMarkup`.
2. During #4182, commit `5aef4396c` ("ship SVG render as standalone svg-preview.js module (respect 05073
   freeze)") moved that code out of `operator-console.js` and into
   `services/gateway/src/frontend/command-hub/svg-preview.js`. The VTID-05072/05073 guard tests freeze
   `operator-console.js` byte for byte. `sanitizeSvgMarkup` is defined at `svg-preview.js:85` and exported on
   `window.SvgPreview` at `:374`. `git grep sanitizeSvgMarkup origin/main -- services/gateway/src/frontend/command-hub/operator-console.js`
   finds nothing. `index.html` loads the module as `/command-hub/svg-preview.js?v=20261121-vtid-05082`.
3. The manifest was added in `59a144151`, before the move, and was never updated. `git log origin/main --
   docs/validation/VTID-05082/staging-tests.json` lists only `80e2b3553`. Its `note` still says "code in operator-console.js".
4. Staging is not stale. Read-only GETs of `https://preview-aws-gateway.vitanaland.com/command-hub/` on 2026-10-20:
   `operator-console.js?v=20261121-vtid-05082` is 200 without `sanitizeSvgMarkup`.
   `svg-preview.js?v=20261121-vtid-05082` is 200 and contains `sanitizeSvgMarkup`. `index.html` carries the
   `svg-preview.js?v=20261121-vtid-05082` script tag.
5. Every gateway STAGING-VERIFY run since #4182 has failed on this test, and on nothing else in the last run:
   39390425454, 39391474724, 39398336187, and 39456004226 (21/22, verified commit `3063c954`). Production is at
   `4e0e7d1f`, before 05082, so this suite is in every release range. It blocks Gate 2 for every gateway release
   (VTID-05208, VTID-05254 and later) until it is fixed. `scripts/ci/staging-verify/run.mjs` `loadManifest`
   reads the manifest from the checkout, so a corrected file on `main` takes effect on the next run.

**Which side is stale: the test.** The module move was deliberate and is documented in the commit message.

### B. Gateway Jest: the VTID-05077 test pins an old app.js cache key
1. TEST-SUITE run 39421080981 on `main` (`3063c9543`), job "Gateway (Jest, ~7.5k tests)": 1 failed, 28466 passed.
   The failing test is `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts`,
   "VTID-05077 planner fallback rate on the autopilot screen › the spend route returns the planner summary and the screen shows it as a chip".
2. The failing assertion is at `:212`:
   `expect(html).toContain('/command-hub/app.js?v=20261120-vtid-05148');`.
   The log reports `Expected substring: "/command-hub/app.js?v=20261120-vtid-05148"`. The received `index.html`
   contains `/command-hub/app.js?v=20261121-vtid-05082`.
3. #4182 (`80e2b3553`, diff of `services/gateway/src/frontend/command-hub/index.html`) bumped
   `app.js`, `operator-console.js` and `styles.css` from `?v=20261120-vtid-05148` to `?v=20261121-vtid-05082`.
   It did that on purpose, for the VTID-04696 asset-bump gate. The commit message says it updated "the
   version-pinning unit tests", but it missed this one. `index.html:32` on `origin/main` is
   `<script src="/command-hub/app.js?v=20261121-vtid-05082"></script>`. The test's other assertions (route
   regexes, `label: 'Planner fallback 24h'` in `app.js`) still pass. Only `:212` fails.

**Which side is stale: the test.** The bumped cache key is the intended shipped value.

## Change (two independent lanes, test data only, no product code)
1. Lane `staging-test-05082`: edit `docs/validation/VTID-05082/staging-tests.json`.
   - Test #3: path becomes `/command-hub/svg-preview.js?v=20261121-vtid-05082`, and the name becomes "deployed
     svg-preview.js contains the SVG sanitizer/renderer". `expect_status: 200` and
     `expect_body_contains: "sanitizeSvgMarkup"` stay as they are. Update the `reason` to name `svg-preview.js`.
   - `note`: say the code lives in `svg-preview.js`, loaded by `index.html`, and not in `operator-console.js`.
   - Tests #1 and #2 are unchanged. No test is removed, and no assertion is loosened (rule 50). The suite still
     proves that the shipped sanitizer is served on staging, at the file where it lives.
   - The lane's own record, `docs/validation/<VTID>/`, holds a read-only `staging-tests.json`: GET `/alive`,
     and GET `/command-hub/svg-preview.js?v=20261121-vtid-05082` contains `sanitizeSvgMarkup`.
2. Lane `jest-05077-cachebuster`: edit `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212`
   so it expects `'/command-hub/app.js?v=20261121-vtid-05082'`. Nothing else in the file changes. The exact
   string is kept, not a regex, because that is the file's existing pattern and the smallest change. A later
   cache bump has to update it, as the asset-bump gate already requires for its sibling pins.
   - The lane's own record, `docs/validation/<VTID>/`, holds a read-only `staging-tests.json`: GET `/alive`,
     and GET `/command-hub/index.html` contains `/command-hub/app.js?v=20261121-vtid-05082`.

## Out of scope
- `index.html`, `svg-preview.js`, `operator-console.js` and every other product file. That includes the two
  harmless stale comments (`index.html:28`, the `svg-preview.js` header). Fixing them would touch frozen and
  deploy paths for no functional gain.
- Turning cache-key pins into regexes across the test suite.

## Overlap
Open PR #4207 `plan(gateway-test-cachebust)` (lane `fix-pin`) targets the same `:212` pin. Its `_plan` is
escalated (partner unavailable) and `fix-pin` is blocked with `next_actor: claude`. It does not touch the
VTID-05082 manifest. Whichever plan's lane merges first fixes the pin. The other lane then has an empty diff
and is closed as done with a log entry. Lane B never changes anything other than `:212`, so the two cannot conflict
in substance. Kiro does not close #4207 itself.

## Verification
- Lane `staging-test-05082`:
  - `node -e "JSON.parse(require('fs').readFileSync('docs/validation/VTID-05082/staging-tests.json','utf8'))"`
    succeeds, and the same check passes for the lane's own `staging-tests.json`.
  - A read-only, unauthenticated GET of `https://preview-aws-gateway.vitanaland.com/command-hub/svg-preview.js?v=20261121-vtid-05082`
    returns 200 and the body contains `sanitizeSvgMarkup`. Staging only. No suite targets production.
  - After merge, the next gateway STAGING-VERIFY passes VTID-05082 test #3.
- Lane `jest-05077-cachebuster`:
  - `cd services/gateway; npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts` passes, all tests in the file.
  - The lane's `staging-tests.json` parses as JSON. The gateway Jest job in TEST-SUITE is green on the lane PR.
<!-- plan:end -->
