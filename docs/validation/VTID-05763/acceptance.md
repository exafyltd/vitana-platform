# VTID-05763 — autonomous-to-staging, lane `gate-invariants-ci`

Plan: `.kiro/specs/autonomous-to-staging/plan.md` §3.1, merged as `bf1cb134e6` (#5000). Depends on
`machine-gate-protected` (VTID-05765, #5002, merged `e7077f27c3`).

## What changed
- `.github/workflows/GATE-INVARIANTS.yml` (new): on every push to `main`, daily at 04:17 UTC and on dispatch, fetches
  `origin/main` and runs `node --test scripts/collab/gate-invariants.test.mjs` (the VTID-05765 invariants: protected list
  complete, two-model rule intact in land-guard and the PM, prod-reference guard and this workflow enforced once they
  exist) and `scripts/ci/workflow-trigger-check.test.mjs`. Top-level `permissions: contents: read`, no secrets. No
  `pull_request` trigger (a path-filtered PR workflow would need a services-registry entry outside this lane's paths);
  on PRs the static test runs in TEST-SUITE's `unit` job.
- `scripts/ci/workflow-trigger-check.test.mjs` (new): asserts the push-to-main (no path filter) and daily schedule
  triggers, that the invariant suite runs, that `origin/main` is fetched, read-only permissions, no secrets and no
  `continue-on-error`, with mutation fixtures for each.

## Acceptance criteria → tests

AC-1 GATE-INVARIANTS.yml runs the gate invariants on every push to `main` (no path filter) and on a daily schedule.
TEST: scripts/ci/workflow-trigger-check.test.mjs ("GATE-INVARIANTS.yml runs the invariants on every push to main and daily, read-only")
TEST: scripts/collab/gate-invariants.test.mjs ("working-tree invariants hold on this checkout": the push-to-main trigger is now enforced, no longer deferred)

AC-2 Removing a trigger, path-filtering the push, making the schedule non-daily, dropping the invariant step, the
`origin/main` fetch or read-only permissions, or adding a secret or `continue-on-error` is caught.
TEST: scripts/ci/workflow-trigger-check.test.mjs ("mutations: each weakened trigger or step is caught")

AC-3 The first run on `main` after merge is green and its run URL is in `commands.log`.
TEST: GATE-INVARIANTS workflow run on the merge commit (URL appended to commands.log by the closing record)

Red on base: `outputs/red-on-base.txt` (2 fail, workflow absent). Green: `outputs/trigger-check-green.txt` (3/3),
`outputs/gate-invariants-green.txt` (6/6), `outputs/collab-green.txt` (268/268).

No migration, no secret, no production write; deploys nothing.

## Decisions taken
- tasks.md T1 names `node scripts/collab/gate-invariants.mjs --against main`; VTID-05765 placed the invariants in
  `scripts/collab/gate-invariants.test.mjs` (a node test file, see its Decisions taken), so the workflow runs
  `node --test scripts/collab/gate-invariants.test.mjs` on the `main` checkout.
- Plan §3.1 also asks this workflow to audit each merge commit on `main` that touches a protected gate file for two
  distinct-model accepts (or this plan's bootstrap authority) and emit OASIS `collab.gate.bypass_detected`. That needs
  new audit code outside this lane's `paths` and a gateway credential (this workflow is kept secret-free). It is
  deferred to follow-up lane `protect-gate-workflow`, which also puts this workflow on the protected list.
