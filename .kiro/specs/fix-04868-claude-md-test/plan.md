---
change_class: light
---
# plan(fix-04868-claude-md-test): assert the current plan-sparring rule text in the VTID-04868 test
<!-- plan:begin -->
## Problem
Gateway Jest has been red on `main` since #4239 (VTID-05280, commit `b4ed7891a`, the CLAUDE.md trim by seat
`exafyltd`). Every TEST-SUITE run on `main` since then has failed on `Gateway (Jest, shard 1/4)` (6 of 6, for example
runs 39620438585 and 39788751205). The failing test is
`services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts`, case
`CLAUDE.md carries rules 51-55 and puts allocation after sparring` (lines 28-43). Because the shard is shared, every
gateway PR shows a red gateway Jest check. No open PR fixes it (#4154 is closed, #4161 is older).
Premises, checked against `origin/main` @ `c7819403926c8082084cc60223be57897b7f806a` (raw `git show`, UTF-8):
1. **Only one assertion fails.** Each doc assertion of that case was evaluated against `origin/main:CLAUDE.md`:
   line 30 (`### Plan Sparring Gate (STANDING RULE — VTID-04868)`), line 31 (rules 51..55 `^N\. \*\*`), line 36
   (`/Plan → sparring → owner approval[\s\S]*?→ VTID → code\./`) and lines 37-40 (`Claude Opus 4.6 on AWS Bedrock`,
   `**Fallback chain`, `` `deepseek-v4-pro` ``, `Never Google.`) pass. Line 42 fails:
   `expect(md).toMatch(/Step 0 \(VTID-04868\): spar the plan first\./);`
   The CI log of run 39788751205 could not be fetched (GitHub API 403 rate limit), so the failure was reproduced by
   evaluating every assertion locally against `origin/main:CLAUDE.md`.
2. **What line 42 guards.** That the §4 VTID allocation procedure itself says allocation comes only after the plan is
   sparred, not only Part 1 rules 51-55. It is the "puts allocation after sparring" half of the test title.
3. **#4239 reworded that text; it did not remove the rule.** The old §4.1 "Self-Service Allocation (STANDING RULE —
   VTID-03448)" began with `**Step 0 (VTID-04868): spar the plan first.** Run the plan-sparring skill and get the
   owner's approval of the sparred plan; then allocate, passing the sparring id (p_sparring_id) once the gateway tier
   is live. See Part 1 rules 51–55.` The same commit replaced it with §4.1 "Allocation (STANDING RULE — VTID-03448,
   VTID-04868)". The rule now reads, on `origin/main`:
   - `CLAUDE.md:496` `### 4.1 Allocation (STANDING RULE — VTID-03448, VTID-04868)`
   - `CLAUDE.md:498` `**It is allocated only after its plan is sparred and approved** (Part 1 rules 51–55): owner`
   - `CLAUDE.md:499-502` the sparring id (`p_sparring_id`) is still passed once the gateway tier is live
   - `CLAUDE.md:101` ALWAYS 2b: `allocated only after its plan is sparred and approved`
   - `CLAUDE.md:307` and `:314-316` the Plan Sparring Gate and rule 51 (`Plan → sparring → owner approval … → VTID →
     code.`, already pinned by line 36)
   - `CLAUDE.md:341` IF–THEN 1: `once its plan is sparred and approved`
4. **CLAUDE.md is a protected gate file** (`collaboration.md` §3a, `scripts/collab/protected-gate-files.json`) and
   must not be edited here. The test file is not protected.
## Decision (a): update the assertion to the current canonical wording
The rule still exists in other wording after a deliberate, reviewed doc change (VTID-05280). The guard's intent stays,
so only line 42 changes, to pin the current §4.1 sentence (`CLAUDE.md:498`):
Old (line 42):
```ts
    expect(md).toMatch(/Step 0 \(VTID-04868\): spar the plan first\./);
```
New (line 42, with one comment line above it):
```ts
    // VTID-05280 reworded §4.1; the allocation-after-sparring rule now reads (CLAUDE.md §4.1):
    expect(md).toContain('**It is allocated only after its plan is sparred and approved** (Part 1 rules 51–55)');
```
The `–` in `51–55` is U+2013 EN DASH, as in CLAUDE.md. The file stays UTF-8.
Why this is not weaker: one literal single-line match replaces one literal single-line match. There is no OR fallback
and no regex widening. The new string is 84 characters against the old 41, includes the markdown bold and the
rules 51–55 cross-reference, and is verified literally present (`includes` → true). It fails if §4.1 loses the
sparring-before-allocation sentence, its bold or its link to rules 51–55. Every other assertion in the file is
unchanged.
## Change (one lane `test-assertion`, test only)
1. `services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts`: replace line 42 as above. Nothing else in
   the file changes.
2. `docs/validation/<VTID>/`: `acceptance.md`, `commands.log` and `outputs/` with the red-on-main and green-on-branch
   runs, plus `staging-tests.json` (read-only, modelled on `origin/main:docs/validation/VTID-05265/staging-tests.json`,
   the precedent test-only gateway lane): `vtid` = the lane VTID, `service: "gateway"`, an `http` GET `/alive`
   expecting 200, and a `kind: "existing"` entry
   `npx jest test/vtid-04868-plan-sparring-session-layer.test.ts` with `cwd: services/gateway`.
## Test plan
- Red on main: on a checkout of `origin/main`, `cd services/gateway; npx jest test/vtid-04868-plan-sparring-session-layer.test.ts`
  fails on exactly the line-42 assertion. Output recorded in `docs/validation/<VTID>/outputs/`.
- Green on the branch: the same command passes every case of the file. Output recorded.
- The lane diff touches only the test file and `docs/validation/<VTID>/**`.
- CI on the lane PR: `Gateway (Jest, shard 1/4)` turns green, and STAGING-TESTS-REQUIRED accepts the lane's
  `staging-tests.json`.
- Staging (rule 47, read-only): `services/gateway/**` is a staging deploy path (`AWS-STAGE-DEPLOY-GATEWAY.yml:37-38`),
  so the merge deploys gateway staging. STAGING-VERIFY for the merge commit runs the lane suite (GET `/alive`, the
  Jest file) and must pass; then Gate 2. No product code changes and no suite targets production.
- After merge, the next TEST-SUITE run on `main` passes `Gateway (Jest, shard 1/4)`.
## Out of scope
- `CLAUDE.md` (protected gate file) and every other protected file.
- Every other test, the Jest config and every workflow.
- Restoring the removed "Step 0" line.
<!-- plan:end -->
