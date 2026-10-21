# VTID-04275 — TODO/FIXME scanners self-match their own detection-pattern source

## Report

Continuing the platform owner's "does the Dev Autopilot backlog ever converge
to zero" investigation (VTID-04274) into the remaining findings, found that
3 of the remaining `dev_autopilot` backlog rows were not real code defects at
all — they were the todo-scanner-v1 (two independent implementations: the
inline `scanTodos()` in `scripts/ci/dev-autopilot-scan.mjs`, and the
grep-based scanner in `services/gateway/src/services/recommendation-engine/
analyzers/codebase-analyzer.ts`) flagging its OWN source code.

Both scanners detect TODO/FIXME/HACK/XXX via a word-boundary match over
every line of every scanned source file — with no exception for a file whose
job is to CONTAIN those words as part of implementing the detection itself
(a regex literal, a type union, a string comparison, a scanner's own
metadata description). Confirmed by reading the exact flagged lines:

- `autopilot_recommendations` row `5fbe06e1...` and the `8caa3710...` rollup
  ("Address TODO/FIXME in dev-autopilot-scan.mjs") point at
  `dev-autopilot-scan.mjs:77`'s own
  `severity: m[1] === 'FIXME' || m[1] === 'HACK' ? 'medium' : 'low',` — a
  string comparison against the literal `'FIXME'`, not a comment. The same
  rollup separately names `scripts/ci/scanners/registry.mjs`, whose own
  scanner-catalog entry is titled `'TODO / FIXME / HACK markers'`.
- `autopilot_recommendations` row `23e083d1...` ("Address TODO/FIXME in
  codebase-analyzer.ts") points at `codebase-analyzer.ts:274`'s own
  `const severity = todo.type === 'FIXME' || todo.type === 'HACK' ? 'high' :
  'medium';` — identical shape, independent implementation.

Neither finding can be "resolved" per its own `suggested_action`
("implement, file an issue, or remove if stale") — there is nothing to
implement or remove; the code IS the detector. These are false positives
of the same *class* VTID-04273 fixed for the secret-exposure scanner earlier
this session, not isolated one-offs.

## Fix

Each scanner gets a targeted self-match exclusion, not a change to what
counts as a real TODO anywhere else:

- `dev-autopilot-scan.mjs`: new `TODO_SCANNER_SELF_MATCH_DENYLIST` (its own
  file path, plus `scripts/ci/scanners/registry.mjs`), checked in
  `scanTodos()` before a file is read. `scanTodos` and the denylist are now
  exported so they can be exercised directly in a test.
- `codebase-analyzer.ts`: new `TODO_SCAN_SELF_MATCH_FILE` constant (its own
  path), checked after the grep-output `file` is resolved to a
  repo-relative path, before the TODO type is parsed.

**Incidental fix required to make `dev-autopilot-scan.mjs` testable at all:**
the file's `main()` was invoked unconditionally at module scope with no
`import.meta.url` guard — importing it for the new named export (`scanTodos`)
triggered the WHOLE driver (env-var checks, a live network POST attempt,
`process.exit(1)`) as a side effect. Added the standard ESM
`import.meta.url === pathToFileURL(process.argv[1]).href` "is this the entry
module" guard around the `main()` call. Zero behavior change for the real
CI invocation (`node scripts/ci/dev-autopilot-scan.mjs`, per
`.github/workflows/DEV-AUTOPILOT.yml:72`) — confirmed the guard evaluates
true for that exact invocation shape (see commands.log).

## Acceptance Criteria

AC-1 — `scanTodos()` does not flag its own file
(`scripts/ci/dev-autopilot-scan.mjs`).
TEST: services/gateway/test/scripts/dev-autopilot-todo-scanner-self-match.test.ts

AC-2 — `scanTodos()` does not flag `scripts/ci/scanners/registry.mjs`'s own
scanner-catalog metadata string.
TEST: services/gateway/test/scripts/dev-autopilot-todo-scanner-self-match.test.ts

AC-3 — `scanTodos()` still flags a genuine TODO/FIXME comment in any other
file, including a sibling scanner file.
TEST: services/gateway/test/scripts/dev-autopilot-todo-scanner-self-match.test.ts

AC-4 — `codebase-analyzer.ts`'s TODO scan does not flag its own file.
TEST: services/gateway/test/services/recommendation-engine/analyzers/codebase-analyzer.test.ts

AC-5 — `codebase-analyzer.ts`'s TODO scan still flags a genuine TODO in a
sibling analyzer file — the exclusion is scoped to the one file.
TEST: services/gateway/test/services/recommendation-engine/analyzers/codebase-analyzer.test.ts

## Route evidence

No route is added, removed, or mounted. The Route Mount Evidence Gate does
not apply.

## Not yet independently confirmed live

The next scheduled scan (cron `0 7,19 * * *`) is the real exercise: the two
self-match findings should not recur, and the underlying real gap (if either
file ever has a genuine unresolved TODO) should still be caught.
