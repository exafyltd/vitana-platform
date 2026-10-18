# Tasks — sparring-floor-retry

<!-- lane: floor-retry-code -->
- [ ] T1 Gateway: add `evidence_floor_not_met` to `RETRYABLE_REASONS` in `plan-sparring-service.ts`; add
      service tests: no dedup for floor sessions, dedup kept for `round_cap_reached`.
- [ ] T2 `plan-spar.mjs`: add the reason to `INFRA_REASONS` / `RETRYABLE_REASONS`; legacy-state recompute
      via `client.get` in `step()`.
- [ ] T3 `plan-spar.test.mjs`: fresh floor escalation → infra/retryable + "partner unavailable" log; legacy
      entry retried with the session count unchanged and no `s2-` files; `round_cap_reached` legacy not retried.
- [ ] T4 Verify: node tests, gateway Jest suite, `tsc --noEmit`, `scripts/ci/test-vtid-04868-plan-sparring.sh`;
      after staging deploy, one push to mt-identity yields a new session with read_file-cited findings.

Acceptance: requirements 1–4 hold, and all listed suites are green.
