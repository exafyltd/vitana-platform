# VTID-04200 — Acceptance

Test-only regression coverage for `extractFilePaths()`
(`services/gateway/src/services/dev-autopilot-planning.ts`) — a function the
Dev Autopilot safety gate depends on to derive `files_referenced` for both
the Operator Console's `autopilot_run_task`/`autopilot_execute_task` tools
and the single-shot executor's plan-based path.

## What was checked

`extractFilePaths()` has a "Files to modify" section fast path: when that
section is present and contains at least one path-like line, the function
returns those paths and skips the whole-document fallback scan (which would
otherwise pick up incidental paths mentioned in the Context/Reused
primitives sections — the exact bug VTID's own existing test "ignores prose
path noise when Files to modify section is populated" already pins).

What was UNTESTED: the case where the "## Files to modify" heading is
present (so the fast-path branch is reachable) but every line under it is
prose with no path-like string at all — e.g. a plan generated before the
file list has been filled in, still showing `TBD — not yet identified.`
under the heading. The existing test "returns an empty array for a plan
with no paths" does not exercise this — it uses a document that never has
the heading at all, so it never reaches the fast-path branch's own
early-return condition.

Read the function directly (`services/gateway/src/services/dev-autopilot-planning.ts`,
`extractFilePaths()`): it already gates the early return on
`if (paths.size > 0) return Array.from(paths);` — when the section exists
but yields zero paths, this condition is false and control falls through
to the whole-document fallback scan, which then finds any literal path
elsewhere in the document (e.g. a Context section referencing the real
target file). Confirmed via a throwaway probe test before writing the real
one: this fallback-on-empty-section behavior is already correct in the
shipped code. No source change was needed or made.

This is exactly the shape of gap the "ignores prose path noise" test's own
comment calls out as previously silent-breaking ("this is the exact bug
that caused every auto-generated plan to fail the safety gate") — an
untested branch in this same function has already caused a real production
incident once (VTID-04002's Test Run #1 post-mortem, `files_to_modify`
extraction). Regression coverage for the sibling untested branch (section
present, empty) closes the same class of risk before it recurs: without
this test, a future edit that changed the early-return condition to `if
('Files to modify' in md) return Array.from(paths);` (dropping the
`paths.size > 0` guard) would silently reintroduce "plan has no
files_referenced" for any plan whose Files section exists but is not yet
filled in — and no existing test would catch it.

## Acceptance criteria

AC-1: when the "## Files to modify" section is present but contains no
path-like line, `extractFilePaths()` falls through to the whole-document
scan and returns the path(s) actually named elsewhere in the document,
rather than returning an empty array.
TEST: `services/gateway/test/dev-autopilot-planning.test.ts` —
"VTID-04200: falls through to the whole-document scan when the Files
section exists but names no path".

## Verification

No source file changed — `services/gateway/src/services/dev-autopilot-planning.ts`
is untouched; this VTID is additive test coverage only.

`tsc --noEmit` clean (no type changes possible either way, since no `.ts`
source was edited).

Own suite: `services/gateway/test/dev-autopilot-planning.test.ts` — 16/16
tests passing (1 new).

Regression sweep — every test file this session could identify that
exercises `extractFilePaths()` or the wider `dev-autopilot-planning.ts`
module, plus its direct consumers in the safety gate and on-ramp:
`dev-autopilot-planning.test.ts`, `dev-autopilot-safety.test.ts`,
`vtid-03839-onramp-approved-by-uuid.test.ts`,
`vtid-04132-onramp-open-ended-safety-gate.test.ts` — 4 suites, 50 tests,
0 failures.

## Not done here

- No production/staging deploy signal applies — this is a test-only change
  with no runtime behavior difference; there is nothing to observe live.
- Did not run the full gateway suite (16,700+ tests) — the regression
  sweep above targets every caller of the touched function and its
  immediate dependents, which is the relevant blast radius for a
  test-only addition to one pure function.

OASIS_IMPACT: no — this PR adds one test to an existing test file; it
emits no OASIS events and changes no runtime code path.
