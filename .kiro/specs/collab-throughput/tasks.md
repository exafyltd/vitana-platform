# Tasks — collab-throughput

<!-- lane: throughput-code -->
- [ ] T1 Queue one-pass `collect()`, with the fixture-repo equivalence test, the fixed-process-count test and the
      competing-lane-version test. Compare old vs new output on both real repos.
- [ ] T2 `checkResponses` + `responses_invalid` path; PLAN-SPAR.yml `Comment` runs `always()` with the comment
      file; tests for unknown, duplicate, missing and malformed responses.
- [ ] T3 `checkCodeAccess` + `GET /api/v1/plans/spar/health` (Jest: 401, ok, partial failure, unconfigured);
      `plan-spar.mjs` pre-check (no create or round when not ok); `ALERT-PLAN-SPARRING-CODE-ACCESS.yml`.
- [ ] T4 Verify: node tests, gateway Jest, `tsc --noEmit`. After the staging deploy: health `ok: true`, one alert
      dispatch green, and a queue run timed and recorded. Read-only; no production calls.

Acceptance: requirements 1–5 hold, and all listed suites are green.

- [ ] T5 (D) The throttle escalation's round file names its cause and when to retry (Jest). There is no concurrency
      cap (removed in sparring). Caching, budgets and token accounting are in #4189.
