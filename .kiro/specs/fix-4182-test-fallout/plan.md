---
change_class: light
---
# plan(fix-4182-test-fallout): fix staging + jest checks broken by #4182
<!-- plan:begin -->
## Problem
PR #4182 (VTID-05082, squash-merged as `80e2b3553`) left two checks red on `main`. Both are stale test
expectations. The product code is correct in both cases. Premises were checked against `origin/main` @ `e6ed415a9`
and re-checked for session 2 against `origin/main` @ `1acb6b92d`: neither stale file has changed since `80e2b3553`.

### A. STAGING-VERIFY: the VTID-05082 suite looks for the SVG sanitizer in the wrong file
1. `docs/validation/VTID-05082/staging-tests.json`, test #3 ("deployed operator-console.js contains the SVG
   sanitizer/renderer", `:30`), does `GET /command-hub/operator-console.js?v=20261121-vtid-05082` and expects the
   body to contain `sanitizeSvgMarkup`.
2. During #4182, commit `5aef4396c` ("ship SVG render as standalone svg-preview.js module (respect 05073
   freeze)") moved that code out of `operator-console.js` and into
   `services/gateway/src/frontend/command-hub/svg-preview.js`. The VTID-05072/05073 guard tests freeze
   `operator-console.js` byte for byte. `sanitizeSvgMarkup` is defined at `svg-preview.js:85` and exported on
   `window.SvgPreview` at `:381`. `git grep sanitizeSvgMarkup origin/main -- services/gateway/src/frontend/command-hub/operator-console.js`
   finds nothing. `index.html:29` loads the module as `/command-hub/svg-preview.js?v=20261121-vtid-05082`.
3. The manifest was added in `59a144151`, before the move, and was never updated. `git log origin/main --
   docs/validation/VTID-05082/staging-tests.json` lists only `80e2b3553`. Its `note` still says "code in operator-console.js".
4. Staging is not stale. Read-only GETs of `https://preview-aws-gateway.vitanaland.com/command-hub/` on 2026-10-20:
   `operator-console.js?v=20261121-vtid-05082` is 200 without `sanitizeSvgMarkup`.
   `svg-preview.js?v=20261121-vtid-05082` is 200 and contains `sanitizeSvgMarkup`. `index.html` carries the
   `svg-preview.js?v=20261121-vtid-05082` script tag.
5. Every gateway STAGING-VERIFY run since #4182 has failed on this test, and on nothing else in the last run:
   39390425454, 39391474724, 39398336187, and 39456004226 (21/22, verified commit `3063c954`). Production is at
   `4e0e7d1f`, before 05082, so this suite is in every release range. It blocks Gate 2 for every gateway release
   (VTID-05208, VTID-05254 and later) until it is fixed. `scripts/ci/staging-verify/run.mjs:202` `loadManifest`
   reads the manifest from the `target` checkout, and `STAGING-VERIFY.yml` checks `target` out at the
   **deployed** commit (`ref: ${{ env.SHA }}`), not at `main`. So the corrected file takes effect only on a
   STAGING-VERIFY run whose deployed commit already contains it (see "How Lane A's fix gets verified").

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
   version-pinning unit tests", and it did update the siblings (`test/command-hub/vtid-05067-kiro-console.test.ts:567`,
   `vtid-05069-pipeline-tree.test.ts:184`, `vtid-05071-kiro-approval-visibility.test.ts:182`,
   `vtid-05084-loops-screen.test.ts:148` all pin `20261121-vtid-05082`), but it missed this one.
   `index.html:32` on `origin/main` is `<script src="/command-hub/app.js?v=20261121-vtid-05082"></script>`. The
   test's other assertions (route regexes, `label: 'Planner fallback 24h'` in `app.js`) still pass. Only `:212` fails.

**Which side is stale: the test.** The bumped cache key is the intended shipped value.

## Change (two lanes, test data only, no product code; Lane A merges before Lane B)
1. Lane `staging-test-05082`: edit `docs/validation/VTID-05082/staging-tests.json`.
   - Test #3: path becomes `/command-hub/svg-preview.js?v=20261121-vtid-05082`, and the name becomes "deployed
     svg-preview.js contains the SVG sanitizer/renderer". `expect_status: 200` and
     `expect_body_contains: "sanitizeSvgMarkup"` stay as they are. Update the `reason` to name `svg-preview.js`.
   - `note`: say the code lives in `svg-preview.js`, loaded by `index.html`, and not in `operator-console.js`.
   - Tests #1 and #2 are unchanged. No test is removed, and no assertion is loosened (rule 50). The suite still
     proves that the shipped sanitizer is served on staging, at the file where it lives.
   - The lane's own evidence pack (see "PR title VTID and evidence pack, per lane").
2. Lane `jest-05077-cachebuster`: edit `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212`
   so it expects `'/command-hub/app.js?v=20261121-vtid-05082'`. Nothing else in the file changes. The exact
   string is kept, not a regex, because that is the file's existing pattern, the pattern of its four sibling pins,
   and the smallest change.
   - The lane's own evidence pack (see "PR title VTID and evidence pack, per lane").

## PR title VTID and evidence pack, per lane (sparring R2-F1)
PLAN-SPAR allocates one VTID per lane after approval (`VTID-A` for Lane A, `VTID-B` for Lane B below). Neither lane
reuses VTID-05082: its pack belongs to #4182, and VALIDATOR-CHECK keys every later gate off the title VTID.
- **Which gates fire.** VALIDATOR-CHECK triggers on `services/gateway/test/**` and `docs/validation/**`
  (`.github/workflows/VALIDATOR-CHECK.yml:32-37`), so it runs on **both** lane PRs. STAGING-TESTS-REQUIRED
  (`.github/workflows/STAGING-TESTS-REQUIRED.yml:42-44` → `run.mjs checkPr`, `scripts/ci/staging-verify/run.mjs:466-502`)
  fires only when a file matches a gateway deploy path (`lib.cjs:41-44`, `touchesService` `:102-106`): Lane B
  (`services/gateway/test/**`) yes, Lane A (`docs/validation/**` only) no (`run.mjs:470-472` returns early).
- **What each gate needs, and how each lane meets it.**
  - Title: `VTID-A (fix-4182-test-fallout/staging-test-05082): …` and
    `VTID-B (fix-4182-test-fallout/jest-05077-cachebuster): …`. VALIDATOR-CHECK takes the first title VTID
    (`VALIDATOR-CHECK.yml:87`) and re-checks it (`:318`); check-pr extracts every title VTID (`run.mjs:474`, fails at `:479`).
    Each title names only its own VTID, so check-pr needs exactly one suite.
  - PR body markers (`VALIDATOR-CHECK.yml:94-95`, `:103-106`): `VALIDATION_PROFILE: gateway_backend` (its allowlist,
    `scripts/ci/validator-path-guard.cjs:91-97`, covers `services/gateway/test/` and `docs/validation/`; not
    `command_hub_frontend`, whose Build Gate demands src+dist changes, `VALIDATOR-CHECK.yml:261-268`),
    `SCOPE_ALLOWLIST:`, `ACCEPTANCE:`, `MERGE_PAYLOAD_PREVIEW:` and `OASIS_IMPACT: no` (no OASIS change, so no `OASIS_PROOF:`, `:307-311`).
  - Evidence pack (`VALIDATOR-CHECK.yml:146-150`): `docs/validation/<VTID>/acceptance.md`, `commands.log` and
    `outputs/` (at least one captured output file, so git tracks the directory), modelled on
    `origin/main:docs/validation/VTID-05254/` (`acceptance.md`, `commands.log`, `outputs/*.txt`, `staging-tests.json`).
  - `acceptance.md` mapping (`VALIDATOR-CHECK.yml:152-176`): every `AC-n` line has a `TEST:`, `CURL:` or `UI:` line
    within the next 12 lines.
  - `staging-tests.json`, both lanes: `vtid` equals the lane VTID and `service: "gateway"` (`lib.cjs:187-196`
    `validateManifest`), read-only `http` GETs plus an `existing` Jest ref, like VTID-05254. It is required for Lane B
    (check-pr `run.mjs:484-500`, rule 47). Lane A deploys nothing, so check-pr returns before reading it
    (`run.mjs:469-472`); Lane A ships one anyway as its record. No CI gate checks that record's shape: the VTID-04696
    test only checks its `asset?v=` pins against `index.html` (`vtid-04696-staging-checks-follow-asset-bumps.test.ts:35-46`),
    not `kind`, `expect_*`, `existing` or `service`. So Lane A runs `lib.validateManifest` on it by hand before the PR
    (task A6) and records the result in `commands.log`/`outputs/`; that is a local check, not a gate.
  - No route is added in either lane, so the Route Mount Evidence Gate does not fire (`VALIDATOR-CHECK.yml:271-301`).
- **Lane A pack** (`docs/validation/VTID-A/`): `acceptance.md` (AC-1 test #3 points at `svg-preview.js` → `CURL:` the
  staging GET; AC-2 tests #1/#2 unchanged → `TEST:` `git diff`; AC-3 every suite pin matches `index.html` → `TEST:`
  the VTID-04696 Jest test), `commands.log`, `outputs/` (JSON parse result, `validateManifest` result, staging GET
  result, VTID-04696 Jest output), `staging-tests.json` (GET `/alive`; GET `/command-hub/svg-preview.js?v=20261121-vtid-05082` contains
  `sanitizeSvgMarkup`; `existing`: the VTID-04696 Jest test).
- **Lane B pack** (`docs/validation/VTID-B/`): `acceptance.md` (AC-1 `:212` expects the shipped key → `TEST:` the
  VTID-05077 file; AC-2 suite pins match `index.html` → `TEST:` the VTID-04696 test; AC-3 no positive pin of the old
  key remains → `TEST:` the `git grep` in tasks B5), `commands.log`, `outputs/` (Jest output for both files, the
  grep result), `staging-tests.json` (GET `/alive`; GET `/command-hub/index.html` contains
  `/command-hub/app.js?v=20261121-vtid-05082`; `existing`: `npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts test/vtid-04696-staging-checks-follow-asset-bumps.test.ts`, cwd `services/gateway`).

## The app.js cache-key pin and its other places (sparring R2-F2)
After Lane B, the value `/command-hub/app.js?v=20261121-vtid-05082` that this plan touches lives in three places:
1. `services/gateway/src/frontend/command-hub/index.html:32`: the shipped value, the source of truth. Unchanged.
   Lane B makes the test follow it. Editing it would be a product change and a new cache bump, out of scope.
2. `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts:212`: the stale pin. Lane B sets it to (1).
3. `docs/validation/VTID-B/staging-tests.json` (new, Lane B): created at the value of (1).

They are kept consistent today by construction: (2) and (3) are written from (1) in the same PR, and task B5 greps
that no `toContain` assertion in `services/gateway/test` and no `docs/validation/*/staging-tests.json` suite pin of
`app.js?v=20261120-vtid-05148` remains. That grep scope is deliberate: the old key also survives as prose in
`docs/validation/VTID-05148/acceptance.md:13` (VTID-05148's CURL_PROOF, a historical record of what staging served
then). It is not a suite pin, the VTID-04696 test only reads `staging-tests.json` files (`:36-38`), so no gate reads
it; it is a known, benign leftover and stays unedited. On a future bump the two copies are
not equally exposed: (3), like every `docs/validation/*/staging-tests.json` pin (Lane A's `svg-preview.js?v=` pin
included), is enforced mechanically by
`services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts:31-49`, which fails the bumping PR if
any suite names a version `index.html` does not load. (2) is an exact-string Jest pin like its four siblings; it fails
in the bumping PR's own gateway Jest job, which is what surfaced this bug. So a bump that misses either copy goes red
before merge, not after deploy. The out-of-scope line about regexes means only that this plan does not convert the
pins; it does not waive keeping these three consistent.

## How Lane A's fix gets verified (sparring R1-F1)
- Lane A is docs-only. `docs/validation/**` is not a gateway deploy path (`scripts/ci/staging-verify/lib.cjs:41`,
  `touchesService` at `:102`), and `AWS-STAGE-DEPLOY-GATEWAY.yml` only triggers on `services/gateway/**` and its own
  file. So Lane A's merge triggers no staging deploy, `STAGING-TESTS-REQUIRED` (check-pr) skips its PR, and its VTID is
  never range-verified (`planRange` skips commits that do not touch the service, `lib.cjs:279`). Lane A deploys
  nothing, so it has no Gate 2 of its own: it is done when merged with green checks (VALIDATOR-CHECK included). The
  plan does not claim that Lane A's own commit is verified by the range or that its own suite blocks Gate 2.
- The fix is proven by the **next gateway deploy whose commit contains it**. Lane B touches
  `services/gateway/test/**`, which is a deploy path, so Lane B's merge is that deploy. Order: **Lane A merges
  first, Lane B second** (task B4: Lane B opens its PR only after Lane A has merged). The STAGING-VERIFY run
  for Lane B's merge commit then checks out a tree with the corrected manifest, runs the VTID-05082 suite (05082 is
  still in the production..staging range) and VTID-B's own suite, and must pass both. That run's result is the
  evidence for both lanes, and Lane B's Gate 2 lists both lanes.
- Staging already serves the module: `80e2b3553` is deployed on staging (verified commit `3063c954` contains it),
  and a read-only GET of `svg-preview.js?v=20261121-vtid-05082` on 2026-10-20 returned 200 containing
  `sanitizeSvgMarkup`. Production being at `4e0e7d1f` does not matter for the test: STAGING-VERIFY targets staging
  only (sparring R1-F2, rejected and acknowledged by the partner in round 2).
- If Lane B ends with an empty diff (B3: #4207 fixed `:212` first), the next gateway-deploying merge of any kind is the
  proving run, and the nightly full run (`STAGING-VERIFY-NIGHTLY.yml`, `full=true`, deployed commit) also runs the
  corrected suite once a deploy contains it. Lane A's log records which run proved it.

## Out of scope
- `index.html`, `svg-preview.js`, `operator-console.js` and every other product file. That includes the two
  harmless stale comments (`index.html:28`, the `svg-preview.js` header). Fixing them would touch frozen and
  deploy paths for no functional gain.
- Converting cache-key pins into regexes across the test suite (see R2-F2 above for how the pins stay consistent).

## Overlap
Open PR #4207 `plan(gateway-test-cachebust)` (lane `fix-pin`, still open and unmerged on 2026-10-20) targets the
same `:212` pin. Its `_plan` is escalated (partner unavailable) and `fix-pin` is blocked with `next_actor: claude`. It
does not touch the VTID-05082 manifest. Whichever plan's lane merges first fixes the pin. The other lane then has an
empty diff and is closed as done with a log entry. Lane B never changes anything other than `:212` and its own
evidence pack, so the two cannot conflict in substance. Kiro does not close #4207 itself.

## Verification
- Lane `staging-test-05082`:
  - `node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"` succeeds for
    `docs/validation/VTID-05082/staging-tests.json` and `docs/validation/VTID-A/staging-tests.json`.
  - `lib.validateManifest` (`scripts/ci/staging-verify/lib.cjs:187`) returns `ok` for both files, each with its own
    `vtid` and `service: "gateway"` (task A6; local only, because check-pr skips this docs-only PR).
  - `cd services/gateway; npx jest test/vtid-04696-staging-checks-follow-asset-bumps.test.ts` passes.
  - A read-only, unauthenticated GET of `https://preview-aws-gateway.vitanaland.com/command-hub/svg-preview.js?v=20261121-vtid-05082`
    returns 200 and the body contains `sanitizeSvgMarkup`. Staging only. No suite targets production.
  - VALIDATOR-CHECK is green on the lane PR; STAGING-TESTS-REQUIRED reports "nothing deploys".
  - After merge, the STAGING-VERIFY run for the next gateway deploy that contains the fix (normally Lane B's merge)
    passes VTID-05082 test #3. Lane A itself deploys nothing and has no Gate 2.
- Lane `jest-05077-cachebuster`:
  - `cd services/gateway; npx jest test/vtid-05077-planner-fallback-and-thinking.test.ts test/vtid-04696-staging-checks-follow-asset-bumps.test.ts` passes.
  - The lane's `staging-tests.json` parses and passes `validateManifest` (STAGING-TESTS-REQUIRED green).
  - VALIDATOR-CHECK and the gateway Jest job in TEST-SUITE are green on the lane PR.
  - After merge, STAGING-VERIFY for the merge commit passes VTID-05082 and VTID-B; then Gate 2.

## Re-plan notes (session 2)
Session 1 escalated at round 2 (light class cap; PLAN-SPAR run 39459972063). Every finding of both rounds maps to a
change in this plan:
- **R1-F1** (major, accepted in session 1): kept as is. "How Lane A's fix gets verified" still states Lane A is
  docs-only with no Gate 2 and that Lane B's merge is the proving deploy; merge order A then B is unchanged (task B4).
  Added: VALIDATOR-CHECK does run on Lane A, so Lane A is "done" only with that check green too.
- **R1-F2** (major, rejected in session 1, acknowledged by the partner in round 2): no change of substance; the
  staging evidence stays as stated. Line cite corrected: the export is at `svg-preview.js:381`, not `:374`.
- **R2-F1** (major): new section "PR title VTID and evidence pack, per lane". Both lanes (not only Lane B) carry their
  own VTID in the title, the VALIDATOR-CHECK body markers, and a full `docs/validation/<VTID>/` pack
  (`acceptance.md`, `commands.log`, `outputs/`, `staging-tests.json`) modelled on VTID-05254, with every gate cited.
  tasks.md acceptance for both lanes now lists them. Lane paths: both lane files already list `docs/validation/**`
  in `paths`, which contains `docs/validation/<VTID>/**`; tasks.md "Allowed paths" narrows each lane to its own
  `docs/validation/<VTID>/**` (plus `docs/validation/VTID-05082/staging-tests.json` for Lane A). The lane files are
  not edited in this re-plan, because a `_plan` commit may create a lane file but never edit one
  (`scripts/collab/queue.mjs:384`); tasks.md is the authoritative step list both lane files point to.
- **R2-F2** (minor): new section "The app.js cache-key pin and its other places" names the three places with
  `file:line`, explains why only the test changes (`index.html:32` is the source of truth), adds task B5 (grep for a
  leftover old-key pin) and the VTID-04696 test to Lane B's acceptance, and narrows the out-of-scope regex line.

Session 2 round 1 (two minors, both accepted): the B5 grep scope is stated exactly, with
`docs/validation/VTID-05148/acceptance.md:13` named as an ungated prose leftover; and Lane A's record suite is no
longer said to be "held to the same validity" by VTID-04696. Lane A now validates it locally with
`lib.validateManifest` (task A6).
<!-- plan:end -->
