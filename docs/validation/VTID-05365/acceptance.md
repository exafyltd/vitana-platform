# VTID-05365 acceptance (collab-handoff-check-fix/validator-fix, tasks.md V1-V5)
Every AC below is checked by the reviewer agent against the PR diff. Each maps to a TEST: within 12 lines.
AC-1 (R1) A plan PR with a planner commit and a `ci-plan-spar` commit on `<slug>/_plan` has no "one session per lane"
error. A second `kiro-…` session on `_plan` still fails, and a `ci-plan-spar` commit that edits a lane past `ready`
still fails per file. `ci-plan-spar`'s write permissions are unchanged.
TEST: node --test --test-name-pattern="VTID-05365 R1" scripts/collab/queue.test.mjs
AC-2 (silent failure) `validate --summary` and `scope-check --summary` keep writing the full report to the summary
file and also write every problem as `::error::collab handoff: …` / `::error::lane scope: …` (warnings `::warning::`,
%/CR/LF escaped) plus the status line to stderr. Without `--summary` stdout is unchanged; exit codes unchanged.
TEST: node --test --test-name-pattern="VTID-05365 silent" scripts/collab/queue.test.mjs
AC-3 (batching) `commitsInRange` is one `git log --name-only` with the same records as one `diff-tree` per commit;
lane-file reads go through `commitFileReader` (one `cat-file --batch-check`, one `cat-file --batch`). `validateRange`
and `scopeCheck` start as many git processes for 3 as for 30 commits; errors/warnings equal `validateRangeReference`.
TEST: node --test --test-name-pattern="VTID-05365 batching" scripts/collab/queue.test.mjs
AC-4 The whole collab suite passes; no existing assertion is changed.
TEST: node --test scripts/collab/*.test.mjs
AC-5 `validate` on the heads of #4415 and #4333, before/after with wall-clock time.
TEST: commands.log ("V5")
