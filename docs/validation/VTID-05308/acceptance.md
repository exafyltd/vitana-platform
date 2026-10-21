# VTID-05308 — stale-tests acceptance (vitana-platform side: T2 + T3)

Lane `ci-github-modernization/stale-tests`. The vitana-platform PR fixes the
permanently-red VTID-05082 STAGING-VERIFY suite at the cause (stale cache-bust
token pinned in two read-only assertions) and records the current contract each
changed assertion now matches. Read-only; no staging/production probe from this
session (CLAUDE.md rule 48, common-rules §6).

AC-1 The VTID-05082 staging suite no longer pins the transient
`?v=20261121-vtid-05082` cache-bust token in any assertion (`path` or
`expect_body_contains`) — the cause of the permanent red once staging moves past
the VTID-05082 build. The token survives only as a historical reference in the
explanatory `note`, which is never asserted against staging.
TEST: scan of every test's `path` + `expect_body_contains` in
docs/validation/VTID-05082/staging-tests.json asserts no occurrence of
`20261121-vtid-05082`; see docs/validation/VTID-05308/outputs/no-token.txt.

AC-2 No test is deleted or weakened: all three VTID-05082 tests remain and the
renderer assertion is strengthened (adds the `SvgPreview` global alongside
`sanitizeSvgMarkup`).
TEST: the three test objects (`alive`, index wiring, renderer) are still present
and `expect_body_contains` is a superset of the previous substrings; see
docs/validation/VTID-05308/outputs/test-count.txt and contract.md "No weakening".

AC-3 Each changed assertion matches the durable VTID-05082 contract that is
unchanged on origin/main: index.html wires both `svg-preview.js` and
`operator-console.js`, and the served `svg-preview.js` carries `sanitizeSvgMarkup`
and `SvgPreview`; `express.static` serves the stable path regardless of query
string (services/gateway/src/index.ts).
TEST: substring presence confirmed in the committed command-hub source on the
lane base; see commands.log and docs/validation/VTID-05308/outputs/source-check.txt.

AC-4 The manifest remains schema-valid for STAGING-VERIFY.
TEST: `validateManifest(service=gateway, vtid=VTID-05082)` => `{ ok: true,
errors: [] }`; see commands.log.
