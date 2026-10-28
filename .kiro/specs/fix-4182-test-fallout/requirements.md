# Requirements — fix-4182-test-fallout
Authoritative plan: `plan.md` (between the plan markers). This file adds acceptance criteria only.

## R1 — the VTID-05082 staging suite checks the file that ships the sanitizer
WHEN STAGING-VERIFY runs the VTID-05082 suite against a gateway build that contains #4182,
THEN test #3 does `GET /command-hub/svg-preview.js?v=20261121-vtid-05082` and expects status 200 and the
body to contain `sanitizeSvgMarkup`. Tests #1 and #2 are unchanged. No test is removed and no assertion is
loosened.

## R2 — the VTID-05077 Jest test expects the shipped app.js cache key
WHEN `services/gateway/test/vtid-05077-planner-fallback-and-thinking.test.ts` runs against `origin/main`,
THEN the assertion at `:212` expects `'/command-hub/app.js?v=20261121-vtid-05082'` (the value in
`services/gateway/src/frontend/command-hub/index.html:32`), and every test in the file passes.

## R3 — no product change
No file under `services/gateway/src/**` changes. Each lane changes only its own `paths`.

## R4 — evidence
Each lane commits `docs/validation/<VTID>/staging-tests.json`. It contains only read-only GETs (rule 48) and
parses as JSON.
