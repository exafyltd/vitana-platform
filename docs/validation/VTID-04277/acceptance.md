# VTID-04277 — Acceptance

## Context

User-approved backlog walkthrough task #2 ("investigate whether
`safety-gap-scanner-v1` is a third scanner self-match/structural bug").
Live `autopilot_recommendations` rows `b0aa6815` (snoozed) and `e89e7537`
(activated → dead VTID-02012) are both:

> [rollup] safety-gap-scanner-v1 flagged 8 files with the same fix class
> (safety_gap). Files: e2e/command-hub/roles/developer,
> services/gateway/src, services/gateway/src/routes,
> services/gateway/src/routes/admin, ...

Confirmed this is **not** a scanner self-match bug (unlike VTID-04273/
VTID-04275) — `scanSafetyGaps()` in `scripts/ci/dev-autopilot-scan.mjs`
is a small, hand-authored, fixed catalog of ~10 distinct, unrelated
missing-test gaps (an RLS-write-deny suite, an admin auth-coverage test,
a schema-vs-migrations validator, ...). Each gap's `source_file` is
legitimately either a real file or a directory — that's a deliberate
design choice for a scanner whose job is "point at the area this test
should cover," not a per-file sweep.

The actual defect is in the **rollup synthesis layer**
(`services/gateway/src/services/dev-autopilot-synthesis.ts`
`groupSignalsForRollup()`): it groups any signal cluster sharing
`(scanner, type, severity)` and, once the cluster hits
`ROLLUP_THRESHOLD` (default 5), collapses it into one finding via
`buildRollupSignal()`, whose fallback message assumes the cluster is
mechanically fungible ("Apply the same fix class to every file in
raw.affected_files (typically a one-line change per file)"). All ~10
`safety_gap` signals share the exact same `(scanner, type, severity)`
triple regardless of how unrelated their actual fixes are, so once
≥5 of the catalog's test files are missing, the rollup fires and
mislabels 8 distinct, non-mechanical engineering tasks as "the same fix
class" — misleading for a human reviewer and, had `safety_gap` ever
become `auto_exec_eligible` (it can't today — `TYPE_RISK_CLASS.safety_gap
= 'medium'`, never eligible per `scoreSignal()`), would have told an
executor to apply one fix across eight unrelated test suites.

## Fix

`groupSignalsForRollup()` now routes every `safety_gap` signal straight to
`passthrough`, bypassing the collapse entirely, regardless of cluster
size. Every other signal type's rollup behaviour is unchanged — a control
test (AC-3 below) pins that a 6-signal `dead_code` cluster still collapses
exactly as before.

## Acceptance Criteria

AC-1 — A cluster of `safety_gap` signals at/above `ROLLUP_THRESHOLD`
never collapses into a `[rollup]` finding — each gap is inserted as its
own finding with its own distinct `summary`.
TEST: `services/gateway/test/dev-autopilot-synthesis.test.ts` — "never
collapses safety_gap signals into a rollup, even at/above
ROLLUP_THRESHOLD"

AC-2 — A `safety_gap` cluster below `ROLLUP_THRESHOLD` — which was
already passed through unchanged before this fix (the old code path
routed sub-threshold clusters to passthrough too) — still passes
through unchanged after this fix, i.e. the exemption is a strict
widening, not a behaviour change for the already-correct case.
TEST: `services/gateway/test/dev-autopilot-synthesis.test.ts` — "a
small safety_gap cluster (below threshold) already passed through
unchanged before this fix — still does"

AC-3 — The exemption is scoped to `safety_gap` only — a non-exempt
type (`dead_code`) still collapses into one `[rollup]` finding at/above
`ROLLUP_THRESHOLD`, with `raw.rollup=true` and the correct
`total_files` count, exactly as before this change.
TEST: `services/gateway/test/dev-autopilot-synthesis.test.ts` — "still
collapses a non-exempt type (dead_code) at/above ROLLUP_THRESHOLD — the
exemption is scoped to safety_gap only"

## Not fixed here (explicitly out of scope)

- The two live stuck rows this defect produced (`b0aa6815`/`e89e7537`,
  both pointing at dead VTID-02012/VTID-02013) are **not** cleaned up by
  this code fix alone — this fix only stops the defect from recurring on
  future scans. Releasing/closing the two stale rows is user-approved
  task #1 of the same backlog walkthrough, handled separately.
- No live scanner run has re-confirmed the fixed behaviour yet — the next
  real `dev-autopilot-scan.mjs` run with ≥5 unaddressed `safety_gap` gaps
  is the live exercise; this VTID is verified structurally (unit tests
  against the real `ingestScan`/`groupSignalsForRollup` code path, plus
  mutation verification) only.
