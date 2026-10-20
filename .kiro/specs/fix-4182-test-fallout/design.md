# Design — fix-4182-test-fallout

## What exists (read these, do not copy them)
- `docs/validation/VTID-05082/staging-tests.json`: three http tests. #3 is `GET /command-hub/operator-console.js?v=20261121-vtid-05082`
  with `expect_body_contains: "sanitizeSvgMarkup"`. It is the only failure in STAGING-VERIFY run 39456004226.
- `services/gateway/src/frontend/command-hub/svg-preview.js`: `sanitizeSvgMarkup` at `:85`, exported on
  `window.SvgPreview` at `:374`. It was added by `5aef4396c` because of the VTID-05073 freeze on `operator-console.js`.
- `services/gateway/src/frontend/command-hub/index.html`: loads `/command-hub/svg-preview.js?v=20261121-vtid-05082`.
  `:32` is `<script src="/command-hub/app.js?v=20261121-vtid-05082"></script>`. Both keys were bumped by `80e2b3553` (#4182)
  from `20261120-vtid-05148`.
- `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212`:
  `expect(html).toContain('/command-hub/app.js?v=20261120-vtid-05148');`. This fails in TEST-SUITE run 39421080981
  ("Gateway (Jest, ~7.5k tests)": `Expected substring: "/command-hub/app.js?v=20261120-vtid-05148"`).
- `scripts/ci/staging-verify/run.mjs` `loadManifest(repoRoot, vtid)` reads `docs/validation/<VTID>/staging-tests.json`
  from the checkout.
- Read-only staging suite template: `docs/validation/VTID-05236/staging-tests.json`.

## Evidence for which side is stale
| Check | Expects | Shipped (main + staging) | Stale side | Why |
|---|---|---|---|---|
| VTID-05082 staging #3 | `sanitizeSvgMarkup` in `operator-console.js` | in `svg-preview.js` (staging 200, contains it) | test | `5aef4396c` moved the code on purpose (05073 freeze); the manifest predates the move (`59a144151`) |
| vtid-05077 Jest `:212` | `app.js?v=20261120-vtid-05148` | `app.js?v=20261121-vtid-05082` (`index.html:32`) | test | `80e2b3553` bumped the key on purpose (VTID-04696 asset-bump gate) and missed this pin |

## Decisions
- **Change the tests, not the product.** Both product values are intentional, and `operator-console.js` is
  frozen besides.
- **Keep the assertion's intent.** Lane A still asserts that the sanitizer is served on staging. Lane B still
  asserts that `index.html` loads `app.js` with the current cache key.
- **Exact strings, not regexes.** That matches each file's existing style and is the smallest diff.
- **Two lanes, no dependency.** They touch disjoint files and are proven by different checks
  (STAGING-VERIFY and Jest).
- **Stale comments stay.** `index.html:28` and the `svg-preview.js` header are out of scope, because they sit on product
  and deploy paths.

## Verification
- Lane `staging-test-05082`: both JSON files parse with `node -e "JSON.parse(...)"`. A read-only GET of
  `https://preview-aws-gateway.vitanaland.com/command-hub/svg-preview.js?v=20261121-vtid-05082` returns 200 and
  contains `sanitizeSvgMarkup`. The next gateway STAGING-VERIFY passes VTID-05082 #3.
- Lane `jest-05077-cachebuster`: `cd services/gateway; npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts`
  passes. The lane's own `staging-tests.json` parses.
