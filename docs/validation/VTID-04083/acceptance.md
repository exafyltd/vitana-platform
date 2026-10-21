# VTID-04083 — standing guard against zero-caller functions in Command Hub app.js (T2)

VALIDATION_PROFILE: gateway_backend

Context: `services/gateway/src/frontend/command-hub/app.js` is a plain script
with no build step, no tree-shaking, and no linter flagging unused top-level
functions. Dead code here has only ever been found by someone manually
grepping the whole file — this happened three separate times before this PR
(T1a, T1c, T1d), each finding dozens of zero-caller functions that had
silently accumulated. This PR ships the standing guard T2 asks for, and — in
the course of building it — a fresh manual scan (the same methodology as
T1a/T1c/T1d) found 12 more genuinely zero-caller functions, deleting which
cascaded to 4 more whose only caller was among those 12.

AC-1 — the standing guard test scans app.js for every `[async ]function name(` declaration and flags any whose total textual occurrence count in the file is 1 (only its own definition).
TEST: services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts

AC-2 — a self-invoking IIFE (`(function name() {...})()`) is excluded structurally (a `(` immediately before `function`), not by name — `installAuthFetchInterceptor` is the real example that first exposed this as a needed exception (a naive scan flagged it as zero-caller; it is not dead, it runs at load time).
TEST: services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts

AC-3 — the six Memory Garden / old-Intelligence-panel functions gated behind T1b (a separate, still-open product decision — wire up vs. delete) are the guard's one explicit allowlist, and remain completely untouched by this PR.
TEST: services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts

AC-4 — 16 functions verified zero-caller (12 direct + 4 cascaded once the first 12 were removed) are deleted, along with their stale doc comments, with zero remaining textual occurrence of any of their names anywhere in the file.
TEST: services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts

## Manual verification (commands.log has full output)

- Ran the scan against the pre-existing (main) app.js: 19 zero-caller
  candidates. One (`installAuthFetchInterceptor`) confirmed a false positive
  (IIFE). Six confirmed part of the T1b-gated Memory Garden block (left
  alone). The remaining 12 individually re-verified with a whole-file grep
  after deletion (T1a/T1c/T1d's own methodology) — zero remaining
  occurrences for each.
- Re-ran the scan after deleting the 12: 4 NEW zero-caller candidates
  appeared (`extractLayer`, `fetchAdminDevUsers`, `stopOperatorSse`,
  `closeStepsStream`). Confirmed via `git diff` that each one's only
  deleted-side reference was a call from inside one of the 12 just removed —
  a genuine cascade, the same shape T1d's own `updateVtidsTableBody` →
  `createVtidRow` cascade. Deleted these 4 too, along with their stale doc
  comments (including one now-orphaned section header, "Admin Dev Users").
- Re-ran the scan a third time: stable at exactly 7 candidates —
  `installAuthFetchInterceptor` (IIFE, correctly excluded) + the 6 Memory
  Garden names (T1b-gated, correctly allowlisted). No further cascades.
- `node --check` on app.js — clean.
- `tsc --noEmit` (repo's own pinned binary) — clean.
- `cd services/gateway && npm run build` — clean.
- `jest test/command-hub/` — 10 suites, 180/180 passing (0 regressions in
  sibling T1a/T1c/T1d/T6/T9 suites).

OASIS_IMPACT: no
