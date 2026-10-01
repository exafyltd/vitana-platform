# VTID-04249 — dev_autopilot_runs never finalizes

## What happened

Flagged live in the VTID-04223/04229 CHANGE LOG entry (2026-09-21): scan run
`cf77d23c` stayed at `status='ingesting'`, `new_finding_count 0` forever,
even though the scan itself demonstrably completed (later runs on the same
day produced real findings). Root cause, confirmed by reading the code:

1. `ingestScan`'s step 4 finalize PATCH (`dev_autopilot_runs?run_id=eq...`)
   fired without checking its result — a failed PATCH (network blip,
   transient PostgREST error) left the row silently stuck at `ingesting`
   with no error recorded anywhere.
2. There was no `try`/`catch` around the ingestion body. Any exception
   thrown after the run row was created (step 1) — a malformed signal, an
   unexpected value reaching a scoring helper — propagated straight out of
   `ingestScan`, skipping the finalize step entirely. The route's own
   top-level `catch` (`routes/dev-autopilot.ts`) logs the throw via
   `writeAutopilotFailure`, but never touches the `dev_autopilot_runs` row,
   so the row itself stayed `ingesting` regardless.

Both defects have the same effect: once a run reaches this state there is
no way to tell, from the row itself, whether ingestion actually finished.

## Fix

`services/gateway/src/services/dev-autopilot-synthesis.ts`:

- Extracted the ingestion body (steps 2–5) into `ingestScanBody()`, called
  from inside a `try`/`catch` in `ingestScan()`. Any throw is caught,
  logged loudly (`console.error`, ALWAYS rule 10 / NEVER rule 19), and the
  run row is finalized `status='failed'` with the real error message
  (truncated to 2000 chars) and `completed_at` — never left at `ingesting`.
- The success-path finalize PATCH (step 4) now checks its own result and
  logs loudly on failure, instead of firing and discarding the response.
  A finalize-PATCH failure does **not** flip the overall `ingestScan`
  result to `ok:false` — the findings were already correctly written to
  `autopilot_recommendations`; only the run row's own bookkeeping failed,
  and that's a narrower, more honest signal than pretending the whole scan
  failed.

## Acceptance criteria

AC-1 A run row is finalized `status='done'` with `completed_at`/`new_finding_count`/`updated_finding_count` when ingestion completes normally.
TEST: services/gateway/test/dev-autopilot-synthesis.test.ts — "finalizes the run row with status=done on success"

AC-2 A run row is finalized `status='failed'` with a non-empty `error` and `completed_at` (never left at `ingesting`) when ingestion throws after the run row was created.
TEST: services/gateway/test/dev-autopilot-synthesis.test.ts — "finalizes the run row with status=failed (not stuck at ingesting) when ingestion throws after the run row is created"

AC-3 A finalize-PATCH failure on the success path is logged loudly and does not flip the findings-were-written result to ok:false.
TEST: services/gateway/test/dev-autopilot-synthesis.test.ts — "still reports ok:true when only the finalize PATCH itself fails (findings were already written)"

AC-4 A failure to create the run row in the first place still returns ok:false with no finalize PATCH attempted (nothing to finalize).
TEST: services/gateway/test/dev-autopilot-synthesis.test.ts — "returns ok:false without attempting any writes when the initial run-row insert fails"

## Results

| AC | Result |
|---|---|
| AC-1 | MET |
| AC-2 | MET |
| AC-3 | MET |
| AC-4 | MET |

18/18 tests in `dev-autopilot-synthesis.test.ts` green (14 pre-existing +
4 new); 146/146 in the neighbouring `routes/dev-autopilot.test.ts` green
(no regression); full `dev-autopilot` sweep 25 suites / 576 tests green;
`tsc --noEmit` clean.

## Not verified live

This fixes the mechanism, not a specific stuck row — `cf77d23c` itself is
already 8+ hours old and outside this fix's reach (nothing retroactively
finalizes a row that got stuck before this deployed). The real signal is
the *next* scan run: once this deploys to staging, no future
`dev_autopilot_runs` row should be observed sitting at `status='ingesting'`
with a `completed_at` gap after the scan's own OASIS
`dev_autopilot.scan.started`/`.completed` events show it actually ran.
