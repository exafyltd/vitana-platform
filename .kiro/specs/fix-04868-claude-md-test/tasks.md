# Tasks — fix-04868-claude-md-test
Authoritative plan: `plan.md` (this folder). Lane files: `lanes/`.
VTID: allocated by PLAN-SPAR after approval (one per lane).
<!-- lane: test-assertion -->
## test-assertion — assert the current plan-sparring rule text in the VTID-04868 test (repo vitana-platform)
Allowed paths:
- `services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts`
- `docs/validation/<VTID>/**` (the lane's own record and staging suite, rule 47)
- [ ] T1. Red on main: on a checkout of `origin/main`, run
  `cd services/gateway; npx jest test/vtid-04868-plan-sparring-session-layer.test.ts` and record the output. It fails
  on exactly line 42, `expect(md).toMatch(/Step 0 \(VTID-04868\): spar the plan first\./);`.
- [ ] T2. Replace line 42 of the test file with:
  ```ts
      // VTID-05280 reworded §4.1; the allocation-after-sparring rule now reads (CLAUDE.md §4.1):
      expect(md).toContain('**It is allocated only after its plan is sparred and approved** (Part 1 rules 51–55)');
  ```
  (`–` is U+2013; keep the file UTF-8). Nothing else in the file changes.
- [ ] T3. Green on the branch: the same command passes every case. Record the output.
- [ ] T4. `docs/validation/<VTID>/`: `acceptance.md`, `commands.log`, `outputs/` (T1 and T3 output) and
  `staging-tests.json` modelled on `origin/main:docs/validation/VTID-05265/staging-tests.json`: `vtid` = the lane VTID,
  `service: "gateway"`, `http` GET `/alive` expecting 200, and `kind: "existing"`
  `npx jest test/vtid-04868-plan-sparring-session-layer.test.ts` with `cwd: services/gateway`. Read-only.
Acceptance:
- The test fails on `origin/main` and passes on the branch, with both outputs recorded in `docs/validation/<VTID>/outputs/`.
- The new assertion checks the CURRENT canonical CLAUDE.md wording, the exact string
  `**It is allocated only after its plan is sparred and approved** (Part 1 rules 51–55)` (`CLAUDE.md:498`, §4.1
  `### 4.1 Allocation (STANDING RULE — VTID-03448, VTID-04868)`), replacing
  `Step 0 (VTID-04868): spar the plan first.`. It is at least as specific as the old one: one literal match for one
  literal match, longer, no OR fallback, no regex widening.
- No other test, Jest config or workflow is changed; every other assertion in the file is unchanged.
- `CLAUDE.md` is untouched (and every file in `scripts/collab/protected-gate-files.json`).
- Evidence is in `docs/validation/<VTID>/`; the lane diff touches only the allowed paths.
- After merge, STAGING-VERIFY for the merge commit passes the lane suite, and the next TEST-SUITE run on `main` passes
  `Gateway (Jest, shard 1/4)`.
<!-- lane: test-assertion -->
