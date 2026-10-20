# Tasks — collab-kiro-governance

<!-- lane: owner-governance -->
- [ ] T1 `queue.mjs`: `governance: owner` field (valid only with `executor: kiro`); `validateLane` and `scopeCheck`
      accept governance paths for such a lane; base-revision rule unchanged.
- [ ] T2 `collaboration.md` §7b (both repos, identical), `CLAUDE.md` (both), `.kiro/steering/vitana-kiro-notes.md`
      (both): the owner-named governance lane rule.
- [ ] T3 `queue.test.mjs` cases (plan "Tests"); `docs/validation/<VTID>/` evidence pack.
Acceptance: plan Change A; suites green; Lane scope overridden once on this PR only (bootstrap, plan A.5).

<!-- lane: retry-partner-invalid -->
- [ ] T4 `plan-spar.mjs` and `plan-sparring-service.ts`: `partner_output_invalid` retryable, capped at 2 per plan hash.
- [ ] T5 Tests: `plan-spar.test.mjs` (retried on next push), gateway Jest (re-run, not dedup; third deduped);
      `docs/validation/<VTID>/` evidence pack.
Acceptance: plan Change B; every check green with no override.
