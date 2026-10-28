# VTID-05128 — STAGING-VERIFY: full-run results reach OASIS

Plan: sparred 2 rounds, CONVERGED, owner approved 2026-10-13. Record: `docs/validation/VTID-05128/plan-sparring.md` (hash `d7ccde23…6486`).

Bug: the "Record result in OASIS" step passed the event to curl as one argv argument (`-d "$BODY"`). A full run (VTID-04949, ~1,060 results) is over Linux's 128 KiB per-argument limit → `Argument list too long` (exit 126) on run 38321374295 attempts 1 and 2; full-run results never reached `oasis_events`.

AC-1 A full-run result (1,100 results, body > 128 KiB) is recorded: the body is sent from a file (`curl --data-binary @file`), no argv argument is large, and the posted event keeps every result with `metadata.full: true`, `run_url` and `workflow`.
TEST: scripts/ci/staging-verify/record-oasis.test.cjs

AC-2 Event content is unchanged: a passed run → `staging.verify.passed` / `success`; result fields copied as before (suite, name, ok, problems); a crashed runner (no results.json) → `staging.verify.failed` with `crashed: true`.
TEST: scripts/ci/staging-verify/record-oasis.test.cjs

AC-3 Failures stay loud: missing Supabase credentials exit non-zero before sending; a failed POST fails the step; the body file is removed afterwards.
TEST: scripts/ci/staging-verify/record-oasis.test.cjs

AC-4 The workflow step calls `runner/scripts/ci/staging-verify/record-oasis.sh`, the workflow no longer contains `-d "$BODY"`, and the runner's sparse checkout still includes the script; the rest of STAGING-VERIFY is unchanged.
TEST: scripts/ci/staging-verify/record-oasis.test.cjs
TEST: services/gateway/test/vtid-04715-staging-verify-deployed-commit.test.ts

AC-5 The original failure reproduces with the old inline step (exit 126, "Argument list too long") and the new script records the same input (exit 0).
TEST: docs/validation/VTID-05128/outputs/reproduction.txt

This change deploys nothing (workflow + script), so there is no staging deploy and no Gate 2. Post-merge proof: one full STAGING-VERIFY dispatch, then a read-only check that `oasis_events` holds its `staging.verify.*` row with `metadata.full = true`.

OASIS_IMPACT: yes — restores recording of `staging.verify.*` events for full runs (no new topic, no shape change).
OASIS_PROOF: scripts/ci/staging-verify/record-oasis.sh POSTs the same `staging.verify.<outcome>` event to `oasis_events` as before (topic, status, message and metadata unchanged — AC-2), now with the body read from a file; record-oasis.test.cjs asserts the posted payload for full, passed and crashed runs. Post-merge: the next full STAGING-VERIFY run's row with `metadata.full = true` is checked read-only in `oasis_events`.
