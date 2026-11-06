# Acceptance — VTID-05463 (mt-track-s-r2 / s-j-retire-allowlist-v2)
Supersedes `s-j-retire-allowlist` (VTID-05441, never built).

The code change lives in `exafyltd/vitana-v1` PR #1568. This PR carries the lane state and the evidence.

| Acceptance | Evidence |
|---|---|
| R1 `linkedin-import` in `ALLOWLIST`, nothing else in the workflow changes | one-line diff in `.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml` (`:45`) |
| R2 `linkedin-import` in the test's `RETIRED`, no other test line changes | one-line diff in `src/lib/supabase-functions-retire.vtid-05008.test.ts` |
| Red on base | `outputs/red.txt`: with only the test entry, on main before #1555: 1 failed, 5 passed |
| Green after | `outputs/green.txt`: 6 passed (6) on main after #1555 (`linkedin-import` folder gone) |
| Guards untouched | main-only, folder-absent and no-caller checks unchanged; the suite's three guard cases pass |
| R4 no dispatch | the PR runs no workflow; the production retire is the owner question asked with Gate 2 (plan §3) |
| Staging proof | not verified on staging: deploys nothing; Vitest suite referenced as `existing` |

## Acceptance criteria

AC-1: The retire workflow `ALLOWLIST` and the VTID-05008 test `RETIRED` list both name `linkedin-import`, and no other line of either file changes (vitana-v1 PR #1568).
TEST: `npx vitest run src/lib/supabase-functions-retire.vtid-05008.test.ts` in `exafyltd/vitana-v1` passes 6 of 6 (`outputs/green.txt`).

AC-2: The suite is red on base before the change: with only the test entry added, it fails 1 and passes 5 (`outputs/red.txt`).
TEST: `outputs/red.txt` holds the recorded run; `commands.log` names the command.

AC-3: The guard checks are unchanged: the main-only, folder-absent and no-caller checks, and the suite's three guard cases.
TEST: `npx vitest run src/lib/supabase-functions-retire.vtid-05008.test.ts` (`outputs/green.txt`).

AC-4: This PR dispatches no workflow. The production retire stays an owner question at Gate 2 (plan §3).
TEST: the suite's dispatch-only check in `src/lib/supabase-functions-retire.vtid-05008.test.ts`, run by the command in AC-1.
