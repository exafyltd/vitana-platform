# VTID-05308 — stale-tests, T2 (vitana-platform): VTID-05082 staging contract

## The permanently-red suite
`docs/validation/VTID-05082/staging-tests.json`, run by STAGING-VERIFY
(`scripts/ci/staging-verify/run.mjs`) in the nightly full run against the
staging gateway (`preview-aws-gateway.vitanaland.com`). Read-only (GET).

## Why it was permanently red (cause)
Two of its three assertions pinned the transient cache-bust token
`?v=20261121-vtid-05082`:
- test 2 asserted `index.html` body contains
  `operator-console.js?v=20261121-vtid-05082`;
- test 3 fetched `/command-hub/svg-preview.js?v=20261121-vtid-05082`.

That `?v=` token is bumped by the next Command Hub change (it is only a browser
cache key). Once staging serves any build past the VTID-05082 commit — which it
always eventually does — the body no longer contains that exact token and the
versioned path no longer matches, so the read-only suite can never go green
again. This is a stale assertion, not a real staging regression.

## Current contract the changed assertions now match
The durable behaviour VTID-05082 shipped (unchanged on `origin/main`):
- `index.html` wires **both** modules — it loads `svg-preview.js` (so
  `window.SvgPreview` exists) and then `operator-console.js`
  (services/gateway/src/frontend/command-hub/index.html). Verified both
  substrings present on the lane base.
- The served `svg-preview.js` contains the sanitizer `sanitizeSvgMarkup` and
  the `SvgPreview` global the console depends on
  (services/gateway/src/frontend/command-hub/svg-preview.js). Verified both
  substrings present on the lane base.
- The gateway serves `/command-hub/**` via `express.static`
  (services/gateway/src/index.ts:1655), which ignores the query string — so
  the unversioned path `/command-hub/svg-preview.js` returns the same file as
  the versioned one.

## Fix (cause, not symptom)
- test 2 now asserts `expect_body_contains: ["svg-preview.js",
  "operator-console.js"]` (both modules wired) instead of the pinned
  `operator-console.js?v=20261121-vtid-05082`.
- test 3 now fetches the stable path `/command-hub/svg-preview.js` and asserts
  `expect_body_contains: ["sanitizeSvgMarkup", "SvgPreview"]`.

## No weakening
- No test is deleted; all three tests remain (alive, index wiring, renderer).
- The renderer check is **strengthened** (adds `SvgPreview` alongside
  `sanitizeSvgMarkup`).
- The new substrings are prefixes/supersets of the old ones and the unversioned
  static path returns the identical file, so the change cannot turn a passing
  run red; it only removes the cache-token fragility that guaranteed a red.
- Manifest remains schema-valid (`validateManifest` ok, read-only GETs only).

## Verification constraint
STAGING-VERIFY's runtime assertions execute only against the live staging
gateway, which this session must not and did not probe (CLAUDE.md rule 48,
common-rules §6). The fix was validated by: (a) confirming all asserted
substrings exist in the committed source on the lane base; (b) confirming the
static-serving semantics that make the unversioned path equivalent; (c)
`validateManifest` passing. The suite proves itself green on the next
STAGING-VERIFY nightly run against staging; it is read-only there.
