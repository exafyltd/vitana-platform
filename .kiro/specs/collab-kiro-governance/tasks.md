# Tasks — collab-kiro-governance

<!-- lane: owner-governance -->
- [ ] T1 `queue.mjs`: `governance: owner` field (valid only with `executor: kiro`); `validateLane` and `scopeCheck`
      accept governance paths for such a lane; `governance` joins `PERM`; the self-grant check in `validateRange`
      (plan A.3a).
      **Sparring R3-N1 (converging round):** one constant, strict comparison `fm.governance === 'owner'` in both
      `validateLane` and `scopeCheck`; any other value (`owners`, `bob`, empty string), the field on a `claude` lane,
      or on a lane without `executor: kiro` is an error. `queue.test.mjs` asserts each.
- [ ] T2 `collaboration.md` §7b (both repos, identical), `CLAUDE.md` (both), `.kiro/steering/vitana-kiro-notes.md`
      (both): the owner-named governance lane rule.
- [ ] T3 `queue.test.mjs` cases (plan "Tests"); `docs/validation/<VTID>/` evidence pack.
Acceptance: plan Change A; suites green; Lane scope overridden once on this PR only (bootstrap, plan A.5).

<!-- lane: retry-partner-invalid -->
- [ ] T4 `plan-spar.mjs`, `plan-sparring-service.ts`, `routes/plans-spar.ts`: `partner_output_invalid` retryable, cap per
      producer, `deduplicated`/`retry_exhausted` surfaced to CI (plan B.3).
      **Sparring R3-N2 (converging round):** the cap is **2 partner passes in total per producer: the first plus one
      automatic re-run**. The gateway re-runs when the count of escalated `partner_output_invalid` sessions for the
      producer is below 2, and dedups with `retry_exhausted` at 2. Gateway Jest pins exactly 2 sessions; the CI test
      asserts `create` is called exactly twice and a third push creates nothing.
- [ ] T5 Tests: `plan-spar.test.mjs` (retried on next push), gateway Jest (re-run, not dedup; third deduped);
      `docs/validation/<VTID>/` evidence pack.
Acceptance: plan Change B; every check green with no override.
