# VTID-04085 — Command Hub symbol index generator (T8)

VALIDATION_PROFILE: gateway_backend

Context: `services/gateway/src/frontend/command-hub/app.js` alone is 55K+
lines with no build step. Real measured cost of navigating it without an
index: CLAUDE.md's VTID-04037 CHANGE LOG row records an agent spending ~40
of its 60 turns just locating code via repeated `read_file`/`search_text`
calls before a 2 MB read-size cap made even that fail outright (VTID-04042).
An index mapping every function name to its exact line range turns "find
`renderDevAutopilotStepsView`" into one lookup instead of a multi-turn
search-and-scroll.

`services/gateway/scripts/generate-command-hub-symbol-index.mjs` scans all
11 `*.js` files directly under `command-hub/` for `[async ]function name(`
declarations at ANY nesting depth (not just top level), via a
string/template-literal/comment-aware character scanner, and writes
`services/gateway/specs/command-hub-symbol-index.json`.

AC-1 — finds a simple top-level function declaration and computes its exact 1-based start/end line range.
TEST: services/gateway/test/scripts/generate-command-hub-symbol-index.test.ts

AC-2 — finds function declarations NESTED inside another function's body, not just top-level ones (the defect the first scanner design had — jumping past a matched function's whole body silently skipped every declaration nested inside it, caught by comparing against a naive whole-file name scan that returned more names than the body-skipping scanner did).
TEST: services/gateway/test/scripts/generate-command-hub-symbol-index.test.ts

AC-3 — a self-invoking function expression, `(function name() {...})()`, is labeled `kind:"iife"` rather than `"function"` — detected structurally (a `(` immediately before `function`), matching the same convention VTID-04083's zero-caller guard test uses for `installAuthFetchInterceptor`.
TEST: services/gateway/test/scripts/generate-command-hub-symbol-index.test.ts

AC-4 — a literal `{`/`}` character inside a string or template literal is never counted as real brace depth (which would find the wrong end line, or none at all), and a `function name(` sequence inside a `//` or `/* */` comment is never counted as a real declaration.
TEST: services/gateway/test/scripts/generate-command-hub-symbol-index.test.ts

AC-5 — `--check` exits 0 with "in sync" when the stored index already matches regenerating from source, and exits 1 with "out of sync" when the source has changed since the index was last written (drift detection, matching `regen-screens-catalog.mjs`'s own `--check` convention).
TEST: services/gateway/test/scripts/generate-command-hub-symbol-index.test.ts

AC-6 — running against the real repo's Command Hub source finds 500+ functions and correctly nests the known `installAuthFetchInterceptor` IIFE / `getActiveRole` regression case (real-world confirmation of AC-2/AC-3 together, not just synthetic fixtures).
TEST: services/gateway/test/scripts/generate-command-hub-symbol-index.test.ts

## Manual verification (commands.log has full output)

- `node --check` on the generator — clean.
- Ran against the real 11-file Command Hub source: 856 functions found
  (692 in app.js alone) in ~0.27s.
- Spot-checked known nested functions (`installAuthFetchInterceptor` →
  `getActiveRole`/`getRefreshToken`/`performRefresh`) and a known top-level
  one (`renderMemoryGardenView`) against the real file — line ranges match
  manual inspection.
- `tsc --noEmit` (repo's own pinned binary) — clean.
- `cd services/gateway && npm run build` — clean.
- `jest test/scripts/generate-command-hub-symbol-index.test.ts` — 8/8
  passing.

## Scope note

Deliberately matches T1a/T1c/T1d/T2's established methodology: classic
`function name(...)` / `async function name(...)` declarations only, not
`const name = () => {}` arrow functions or object-literal method shorthand
— consistent with what this repo's own dead-code cleanups have already
treated as "a function" throughout the T1/T2 chain, rather than inventing a
wider (and untested) detection scope. No CI workflow to auto-regenerate the
index on push is added here (unlike `REGEN-SCREENS-CATALOG.yml`'s pattern
for the screens catalog) — the generator + `--check` mode are the
deliverable this task asked for; wiring an auto-regen workflow is a
reasonable, separable follow-up if this index proves useful in practice.

OASIS_IMPACT: no
