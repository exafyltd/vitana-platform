# VTID-05353 acceptance (pm-ci-load/pr-ci-concurrency, tasks.md C1-C3)

Every AC maps to a TEST: within 12 lines. Raw output: `outputs/red-on-base.txt`. Commands: `commands.log`.
Change types: Infrastructure/CI. Deploys nothing.

AC-1 `UNIT.yml` and `PHASE-2B-DOC-GATE.yml` each carry a top-level `concurrency` block whose group is
`<name>-${{ github.event.pull_request.number }}` (the PR-GATE.yml pattern, no `github.ref` fallback) with
`cancel-in-progress: true`; a newer push of the same PR cancels the superseded run.
TEST: node --test scripts/ci/workflow-concurrency/concurrency.test.mjs

AC-2 No trigger, job, step or path filter changes: both still run on `pull_request` with no `paths`/`paths-ignore`,
so the required check `unit` runs on every PR head and never stays pending.
TEST: node --test scripts/ci/workflow-concurrency/concurrency.test.mjs; git diff origin/main -- .github/workflows

AC-3 Red on base (2 of 5), green on head (5/5); the full UNIT script-test set still passes; both files parse as YAML
with the same top-level shape as PR-GATE.yml.
TEST: node --test $(find scripts … *.test.mjs) (see commands.log); ruby YAML.safe_load (commands.log)
