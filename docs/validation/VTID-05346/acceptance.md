# VTID-05346 acceptance (quality-checks/pipeline-quality, tasks.md T1-T4)

Change types: Tooling/docs. Red-on-base: `red-on-base.txt` (0/7 pass). Commands and counts: `commands.log`.

AC-1 `.kiro/pipeline/quality-checks.md` defines "verified", the Acceptance template (first bullet `Change types:`,
then Outcome, States, Surfaces, Locales, Accessibility, Contract, Staging proof) and one section each for UI, Backend,
Database, Integration, Infrastructure/CI, Tooling/docs, each item traced to plan §2 evidence; plus test quality and
merge (squash).
TEST: node --test scripts/collab/quality-checks.test.mjs

AC-2 `planning.md` §3, `lane-code.md` steps 7-9, `lane-review.md` link it; the review step reads `Change types:` from
`tasks.md` and passes those "Reviewer" lines as checklist item 10; `lane-land.md` 3d merges with squash; the
`reviewer_seat` sentence of `planning.md` names the governance-path requirement. Additions only; no step removed.
TEST: node --test scripts/collab/quality-checks.test.mjs

AC-3 `.github/pull_request_template.md` has `## Verification`; each VALIDATOR-CHECK marker still appears exactly once.
TEST: node --test scripts/collab/quality-checks.test.mjs

AC-4 Only the lane's `paths` change; no protected gate file, `driver.md`, `preflight.mjs`, hook, guard or steering
file; collab and steering suites stay green; deploys nothing.
TEST: node --test scripts/collab/*.test.mjs && node --test scripts/ci/kiro-steering/guard.test.cjs && node scripts/collab/preflight.mjs
