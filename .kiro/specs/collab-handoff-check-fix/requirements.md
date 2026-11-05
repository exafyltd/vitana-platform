# Requirements — collab-handoff-check-fix
1. A `plan(` PR whose only extra sessions on `<slug>/_plan` are `ci-plan-spar` commits passes the "one session per
   lane" rule. Every other rule about what `ci-plan-spar` may write is unchanged.
2. A second non-CI session on `_plan`, or a `ci-plan-spar` commit that edits a lane beyond the VTID write, still fails.
3. `validate --summary` and `scope-check --summary` print each problem to stderr as a GitHub `::error::` annotation
   (warnings as `::warning::`); the summary file and the exit code are unchanged; output without `--summary` is
   unchanged.
4. The git processes `validateRange` and `scopeCheck` start do not depend on the number of commits in the range; their
   errors and warnings equal today's for the same range (except requirement 1).
5. The specs named in `plan.md` item 5 are listed by exactly one programme each, and `validatePrograms` stays clean.
6. Each change is proven by a test that is red on the base and green on the head (`node --test scripts/collab/*.test.mjs`).
