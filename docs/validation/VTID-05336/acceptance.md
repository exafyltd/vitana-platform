# VTID-05336 acceptance (pipeline-speed/preflight, tasks.md P1-P3)

Every AC below is checked by the reviewer agent against the PR diff. Each maps to a TEST: within 12 lines.
Red-on-base output: `outputs/red-on-base.txt`. Full command log and pass/fail counts: `commands.log`.

AC-1 `scripts/collab/preflight.mjs` runs every CI governance check in one pass and reports all failures grouped per
check with `required` / `report-only in CI` labels, exiting 1 if any check failed: Collab tests, head
`queue.mjs validate`, base-revision `queue.mjs scope-check` (Lane scope), the target repo's `gate.mjs scope`/
`sparring`/`weakening`/`red-green` with `--title`, and Kiro steering `guard.test.cjs` + `guard.cjs .`.
TEST: node --test scripts/collab/preflight.test.mjs
TEST: node scripts/collab/preflight.mjs --repo . --base origin/main --head HEAD --branch kiro/pipeline-speed/preflight --title "VTID-05336 (pipeline-speed/preflight): every CI governance check, locally, in one pass"

AC-2 One run reports every failing check at once (a range with three independent errors is reported together),
scope-check uses the BASE revision's `queue.mjs` while validate uses the HEAD revision, an unchecked part (no
`--title`, missing `gh`/no network) is reported as a failure and never a silent pass, and preflight writes nothing
outside its temp dir.
TEST: node --test scripts/collab/preflight.test.mjs

AC-3 Preflight reuses the repo's own CI scripts with no copied validation logic and no edit to `queue.mjs`,
`gate.mjs`, `lib.mjs` or `PR-GATE.yml`; preflight's validate errors are a superset of what `queue.mjs validate`
prints for the same fixture (parity), proving reuse.
TEST: node --test scripts/collab/preflight.test.mjs
TEST: node --test scripts/collab/*.test.mjs

AC-4 Every push point in `lane-code.md`, `planning.md` and `driver.md` runs preflight first and no other runbook is
changed; the runbook-text check catches a push point without preflight.
TEST: node --test scripts/collab/preflight.test.mjs
