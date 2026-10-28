# VTID-05381 acceptance (quality-checks-followup/merge-policy-text, tasks.md T1-T3)

Change types: Tooling/docs. States, Surfaces, Locales, Accessibility: n/a (no runtime behaviour, no UI, English rule
text). Contract: the PM `act.ts` merge strategy, pinned by the test. Staging proof: n/a, deploys nothing.
Red-on-base: `red-on-base.txt` (2 new tests fail, 7 pass). Commands: `commands.log`.

AC-1 The Merge section of `.kiro/pipeline/quality-checks.md` names the policy sources (PM `act.ts`
`merge_strategy: 'squash'`, `planning.md` §6), cites `lib.cjs` `planRange` where rule 47 is decided, and states that a
GitHub default merge commit has no VTID in its subject; the test fails if the PM ever merges with another strategy.
TEST: node --test scripts/collab/quality-checks.test.mjs

AC-2 `docs/DEPLOYMENT-PIPELINE.md` (VTID-05076 paragraph) and the `lib.cjs` range comment no longer say a merge
commit's subject carries the PR title and VTID; they name the default `Merge pull request #<n>` subject.
TEST: node --test scripts/collab/quality-checks.test.mjs

AC-3 `lib.cjs` changes in a comment only; staging-verify tests unchanged and green; only the lane's paths change.
TEST: node --test scripts/ci/staging-verify/lib.test.cjs && node scripts/collab/preflight.mjs
