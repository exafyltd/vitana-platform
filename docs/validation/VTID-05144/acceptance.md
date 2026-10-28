# VTID-05144 - STAGING-VERIFY full runs survive a mid-run staging redeploy

Owner Gate 1 "yes", 2026-10-13. Sparring: `plan-sparring.md` (CONVERGED, 2 rounds,
plan hash `58a5c086fd9e123e078bddd99e1e2d6139cbb11a9888dce00c5fa4069066ccc1`).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: confirmLive resolves a staging stamp the job-start clone does not know by fetching main once from the service's own `origin`; a descendant of the commit under test is `superseded` (with its full sha), a non-descendant or an older ancestor stays `mismatch`, and a failed fetch stays `mismatch` (fail closed).
  TEST: scripts/ci/staging-verify/confirm-live.test.mjs (local git fixture: bare origin, job-start clone, commit pushed after the clone)
AC-2: Every executed result carries `started_at`/`ended_at` (ISO); baseline-problem, invalid-manifest and pre-run-mismatch rows carry `static: true`.
  TEST: scripts/ci/staging-verify/lib.test.cjs (attributeResults over rows of that shape) + run.mjs runSuite/verify (code review: row construction)
AC-3: T_cut = min(max(created_at, runStart)) over the service's staging deploy runs created since runStart - 6 h, excluding `skipped` runs and runs completed before runStart - 5 min; failed/cancelled runs count; lookup failure or no runs → runStart. A result is attributed iff `static` or `ended_at < T_cut` (the boundary is not attributed).
  TEST: scripts/ci/staging-verify/lib.test.cjs (deployCutoff ×4 cases, attributeResults)
AC-4: decideOutcome — not superseded is unchanged; superseded → `failed` if any failed row is attributed, else `superseded`; unattributed rows never count; superseded is never `passed`.
  TEST: scripts/ci/staging-verify/lib.test.cjs (4 new cases + the updated "superseded only when no attributed failure" case)
AC-5: The superseded ready message names the commit staging moved to, T_cut, attributed passed/failed counts and the unattributed count, and lists unattributed failures under "Not attributed — staging was redeploying".
  TEST: scripts/ci/staging-verify/lib.test.cjs (2 buildReadyMessage cases)
AC-6: results.json and the OASIS event carry `superseded_by`, `attribution_cutoff`, `chain` and per-result `attributed`; the verify job outputs `superseded_by` (full sha).
  TEST: scripts/ci/staging-verify/record-oasis.test.cjs (2 new cases) + scripts/ci/staging-verify/workflow.test.cjs (verify job output)
AC-7: The report job posts commit status `error` "superseded — staging moved to <short>; not verified" for a superseded run (never success); a superseded FULL run with chain < 3 re-dispatches `STAGING-VERIFY.yml` full=true on the newer commit with chain+1 using `github.token`; the report job grants itself `actions: write`.
  TEST: scripts/ci/staging-verify/workflow.test.cjs
AC-8: Full runs use their own concurrency group `staging-verify-<service>-full`; `cancel-in-progress: false`; a numeric `chain` input (default 0) reaches run.mjs.
  TEST: scripts/ci/staging-verify/workflow.test.cjs
AC-9: PUBLISH (publish-gate.ts) decides on the newest passed/failed row for the commit, falling back to the newest row only when none exists (superseded-only → blocked); the lookup fetches 10 rows.
  TEST: services/gateway/test/services/testing/publish-gate.test.ts (4 new cases)
AC-10: The Operator run view (run-view.ts latestVerify) uses the same preference: a newer superseded row does not hide an older passed or failed row; superseded-only stays pending.
  TEST: services/gateway/test/operator-runs-view.test.ts (3 new cases)
AC-11: The Gate 2 freshness rule reads "the newest passed or failed full run under 24 h; superseded full runs are skipped; a failed one blocks" in the plan-sparring skill and DEPLOYMENT-PIPELINE §8a.
  TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts (skill still parses/passes) + review of `.claude/skills/plan-sparring/SKILL.md` §6 and `docs/DEPLOYMENT-PIPELINE.md` §8a
AC-12: End to end on staging (after merge, before Gate 2): a gateway full run with a gateway merge during it → `staging.verify.superseded` with `metadata.superseded_by` and a chained full run (chain=1); a quiet-window/nightly full run → `staging.verify.passed` with `metadata.full=true`.
  TEST: STAGING-VERIFY.yml full=true (gateway) — evidence recorded in outputs/README.md before Gate 2

## OASIS

OASIS_PROOF: `staging.verify.*` events (written by `scripts/ci/staging-verify/record-oasis.sh`) gain four metadata fields — `superseded_by` (full sha or null), `attribution_cutoff` (ISO or null), `chain` (integer, default 0) and per-result `attributed` (present only when a superseded run's results were attributed). Topics are unchanged; a superseded run that holds an attributed failure is now recorded as `staging.verify.failed` instead of `staging.verify.superseded`. Proven by record-oasis.test.cjs against a stub curl. Verify post-merge (read-only): `SELECT topic, metadata->>'commit', metadata->>'superseded_by', metadata->>'attribution_cutoff', metadata->>'chain' FROM oasis_events WHERE topic LIKE 'staging.verify.%' AND metadata->>'full' = 'true' ORDER BY created_at DESC LIMIT 5;`
