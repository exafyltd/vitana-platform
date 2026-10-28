# Tasks — collab-handoff-check-fix
Authoritative plan: `plan.md`. VTIDs: allocated by PLAN-SPAR on convergence.

<!-- lane: validator-fix -->
## validator-fix
- [ ] V1. Tests first, red on base (`scripts/collab/queue.test.mjs`): R1 fixture (planner + `ci-plan-spar` on `_plan`
  → no errors) and its two negative cases; CLI `validate` / `scope-check --summary` stderr `::error::` lines; spawn
  count equal for 3 and 30 commits, output equal to `validateRangeReference` (a copy of today's code in the test).
- [ ] V2. R1: skip `ci-plan-spar` `_plan` commits in the session map (`queue.mjs:570`).
- [ ] V3. `--summary` also writes annotations + status to stderr (`:988`, `:1003`).
- [ ] V4. `commitsInRange` in one `git log --name-only`; per-commit file reads through one `catFileBatch`
  (`pmAgentOverreach`, `frontMatterChanged`, `:586`, `:589`, `scopeCheck :675`).
- [ ] V5. `docs/validation/<VTID>/commands.log`: `node --test scripts/collab/*.test.mjs`; `validate` on the heads of
  #4415 and #4333 with time before/after.
Acceptance: `node --test scripts/collab/*.test.mjs` green on head, new tests red on base; only the lane paths change;
no existing assertion loosened; merge only with a legacy `claude` review on the current head or the owner's
instruction (protected gate file).

<!-- lane: program-registry -->
## program-registry
- [ ] P1. Test first, red on base: `scripts/collab/program-registry.test.mjs` (each spec of `plan.md` item 5 → its
  programme; slug pattern; listed exactly once; `validatePrograms` = `[]`). Slugs read from `main` / the open PR heads
  (`git ls-tree -d`), source recorded in `commands.log`. Round 2 (R2-F1): the test also asserts that each programme's
  `repos` contains the repo prefix of every spec this lane adds (`desktop-redesign` gains `vitana-platform`); no CI
  gate checks that otherwise.
- [ ] P2. Add the specs to `docs/programs/native-app/program.md`, `docs/programs/desktop-redesign/program.md` (+ repo
  `vitana-platform`), `docs/programs/standalone/program.md`; re-check open `native-wave2-*` plan PRs at build time.
- [ ] P3. `docs/validation/<VTID>/commands.log`: the test run, and `queue.mjs validate` on #4373's head with no
  programme error.
Acceptance: the test is green on head and red on base; `validatePrograms` clean; only the lane paths change.
