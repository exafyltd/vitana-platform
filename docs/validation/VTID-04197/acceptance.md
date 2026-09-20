# VTID-04197 — Warn loudly when bootstrap build-info URLs are unset

## Report

`operator-bootstrap-pack.ts`'s "Live build-info" section reads
`OPERATOR_BOOTSTRAP_BUILD_INFO_URLS` via `parseBuildInfoTargets()`. When
unset (or set to a string with no valid `label=https://…` entry), the
section correctly degrades — `renderBuildInfo([])` produces one
`(no build-info targets configured …)` line for the model — but nothing
is ever logged server-side. An operator debugging why the Operator
Console has no live commit/env info in its bootstrap pack would find
nothing in CloudWatch; the only way to discover the cause is to dump the
actual rendered prompt sent to the LLM.

## Fix

`parseBuildInfoTargets()` now emits one `console.warn` the first time it
resolves to zero targets — either because the env var is unset, or
because it is set but nothing in it parses to a valid entry — following
the exact `missingTableWarned`/`resetOperatorThreadsWarning` pattern
already established in `operator-threads.ts` (warn once per process, a
reset export for tests). Behavior/return values are unchanged in every
case; this only adds the missing server-side signal.

## Acceptance Criteria

AC-1 — `parseBuildInfoTargets({})` (unset) still returns `[]`, and warns
exactly once via `console.warn`, naming the env var.
TEST: services/gateway/test/vtid-04197-bootstrap-build-info-warning.test.ts

AC-2 — Calling it again in the same process does not warn a second time;
`resetBuildInfoUnconfiguredWarning()` re-arms it.
TEST: services/gateway/test/vtid-04197-bootstrap-build-info-warning.test.ts

AC-3 — A set-but-fully-malformed value also warns once (and includes the
raw value, bounded, for debuggability); a value with at least one valid
entry never warns. The pre-existing mixed-good/bad parsing behavior
(2 valid + 2 malformed entries → the 2 valid ones) is unchanged.
TEST: services/gateway/test/vtid-04197-bootstrap-build-info-warning.test.ts

## Verification

- `tsc --noEmit` (services/gateway): clean.
- New suite: 6/6 tests passing.
- Regression sweep — every existing test touching this file:
  `vtid-04018-operator-bootstrap-pack.test.ts` (17 tests),
  `vtid-04024-bootstrap-pack-open-prs.test.ts` (10 tests),
  `vtid-04031-operator-turn-cost.test.ts` (9 tests) — 4 suites / 42 tests
  total, 0 failures, 0 regressions. In particular
  `vtid-04018-operator-bootstrap-pack.test.ts`'s own pre-existing
  `parseBuildInfoTargets({})` assertion (line 82) still passes unchanged —
  it does not assert on `console.warn`, so the new side effect does not
  break it.

## Not done / explicitly out of scope

- No change to `renderBuildInfo()`'s own rendered text for the model —
  the model-facing degradation message is unchanged; only a new
  server-side log line was added.
- No live/staging verification — the next real signal is this warning
  actually appearing (or not) in CloudWatch logs for the live gateway
  task, which would itself answer whether
  `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS` is really set there.
