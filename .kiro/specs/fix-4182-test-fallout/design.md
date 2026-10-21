# Design — fix-4182-test-fallout

## What exists (read these, do not copy them)
- `docs/validation/VTID-05082/staging-tests.json`: three http tests. #3 (`:30`) is
  `GET /command-hub/operator-console.js?v=20261121-vtid-05082` with `expect_body_contains: "sanitizeSvgMarkup"`.
  It is the only failure in STAGING-VERIFY run 39456004226.
- `services/gateway/src/frontend/command-hub/svg-preview.js`: `sanitizeSvgMarkup` at `:85`, exported on
  `window.SvgPreview` at `:381`. It was added by `5aef4396c` because of the VTID-05073 freeze on `operator-console.js`.
- `services/gateway/src/frontend/command-hub/index.html`: `:29` loads `/command-hub/svg-preview.js?v=20261121-vtid-05082`.
  `:32` is `<script src="/command-hub/app.js?v=20261121-vtid-05082"></script>`. Both keys were bumped by `80e2b3553` (#4182)
  from `20261120-vtid-05148`.
- `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212`:
  `expect(html).toContain('/command-hub/app.js?v=20261120-vtid-05148');`. This fails in TEST-SUITE run 39421080981
  ("Gateway (Jest, ~7.5k tests)": `Expected substring: "/command-hub/app.js?v=20261120-vtid-05148"`). It is the only
  place in `services/gateway/test/**` or any `docs/validation/*/staging-tests.json` that still names that key
  (`git grep 20261120-vtid-05148 origin/main` @ `1acb6b92d`).
- `services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts:31-49`: fails if any
  `docs/validation/*/staging-tests.json` names a `<asset>?v=` that `index.html` does not load.
- `scripts/ci/staging-verify/run.mjs` `loadManifest(repoRoot, vtid)` (`:202`) reads `docs/validation/<VTID>/staging-tests.json`
  from the checkout; `checkPr` (`:466-502`) needs a title VTID and a valid suite when a deploy path is touched.
- `.github/workflows/VALIDATOR-CHECK.yml`: trigger paths `:32-37`, title VTID `:87`, body markers `:94-106`,
  evidence pack `:146-150`, AC mapping `:152-176`, title re-check `:318`.
- Evidence pack template: `origin/main:docs/validation/VTID-05254/` (`acceptance.md`, `commands.log`,
  `outputs/jest-plan-sparring.txt`, `outputs/typecheck.txt`, `staging-tests.json` with `http` + `existing` tests).

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
- **Two lanes, merge order A then B.** They touch disjoint files. STAGING-VERIFY reads manifests from the deployed
  commit (`STAGING-VERIFY.yml` `target` checkout at `env.SHA`), and Lane A (`docs/validation/**`) is not a deploy path
  (`lib.cjs:41`, `:102`), so Lane A's fix is proven by the next gateway deploy that contains it. Lane B
  (`services/gateway/test/**`) is a deploy path, so merging it after Lane A makes its STAGING-VERIFY run the proof.
  Lane A has no Gate 2 of its own.
- **One new VTID and one full evidence pack per lane (R2-F1).** Both lane PRs trigger VALIDATOR-CHECK
  (`VALIDATOR-CHECK.yml:32-37` lists `services/gateway/test/**` and `docs/validation/**`), so both need a title VTID,
  the body markers and `docs/validation/<VTID>/{acceptance.md, commands.log, outputs/}`. Only Lane B triggers
  check-pr, which also needs `docs/validation/<VTID>/staging-tests.json` valid for that VTID. Lane A ships one too,
  as a record. The VTID-04696 test checks only its `asset?v=` pins, and check-pr never reads it, so Lane A validates
  its shape locally with `lib.validateManifest` (task A6), which is a local check, not a CI gate. No lane reuses VTID-05082: VALIDATOR-CHECK
  would then judge the new PR against #4182's acceptance file. Profile `gateway_backend` for both
  (`validator-path-guard.cjs:91-97`); `command_hub_frontend` would fail its src+dist Build Gate (`VALIDATOR-CHECK.yml:261-268`).
- **Only the test pin changes, not `index.html` (R2-F2).** The `app.js` key lives in `index.html:32` (source of truth),
  the Jest pin `:212`, and Lane B's new suite. The lane makes the second and third equal to the first in one PR, so
  `index.html` stays out of the lane's paths: editing it would be a product change and a new cache bump. Future bumps
  stay safe without new code: suite pins are enforced by the VTID-04696 test, the Jest pin fails in the bumping PR's
  own Jest job, and task B5 greps that no Jest `toContain` or `staging-tests.json` pin of the old key is left. The
  prose mention in `docs/validation/VTID-05148/acceptance.md:13` is outside that scope, read by no gate, and stays.
- **Stale comments stay.** `index.html:28` and the `svg-preview.js` header are out of scope, because they sit on product
  and deploy paths.

## Verification
- Lane `staging-test-05082`: both JSON files parse with `node -e "JSON.parse(...)"` and pass `validateManifest` (A6); the VTID-04696 Jest test passes. A
  read-only GET of `https://preview-aws-gateway.vitanaland.com/command-hub/svg-preview.js?v=20261121-vtid-05082` returns
  200 and contains `sanitizeSvgMarkup`. VALIDATOR-CHECK is green. The STAGING-VERIFY run of the next gateway deploy
  containing the fix (normally Lane B's merge) passes VTID-05082 #3.
- Lane `jest-05077-cachebuster`: `cd services/gateway; npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts test/vtid-04696-staging-checks-follow-asset-bumps.test.ts`
  passes. The lane's `staging-tests.json` parses and passes check-pr. VALIDATOR-CHECK and TEST-SUITE gateway Jest are green.

## Re-plan notes (session 2)
- R1-F1: Decisions "Two lanes, merge order A then B" unchanged; VALIDATOR-CHECK now named as a Lane A merge check.
- R1-F2: no change of substance; export line corrected to `svg-preview.js:381`.
- R2-F1: Decision "One new VTID and one full evidence pack per lane", with the gate lines it satisfies. Lane paths
  already cover `docs/validation/<VTID>/**` (`docs/validation/**`); lane files stay unedited (`queue.mjs:384`).
- R2-F2: Decision "Only the test pin changes, not `index.html`", with the three places and why the bump stays safe.
- s2 R1-F1: B5's grep scope stated; `VTID-05148/acceptance.md:13` named as an ungated prose leftover.
- s2 R1-F2: Lane A's record suite is checked by a local `validateManifest` step (A6), not claimed to be gated.
