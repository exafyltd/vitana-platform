# Acceptance — VTID-05463 (mt-track-s-r2 / s-j-retire-allowlist-v2)
Supersedes `s-j-retire-allowlist` (VTID-05441, never built).

| Acceptance | Evidence |
|---|---|
| R1 `linkedin-import` in `ALLOWLIST`, nothing else in the workflow changes | one-line diff in `.github/workflows/SUPABASE-FUNCTIONS-RETIRE.yml` (`:45`) |
| R2 `linkedin-import` in the test's `RETIRED`, no other test line changes | one-line diff in `src/lib/supabase-functions-retire.vtid-05008.test.ts` |
| Red on base | `red.txt`: with only the test entry, on main before #1555: 1 failed, 5 passed |
| Green after | `green.txt`: 6 passed (6) on main after #1555 (`linkedin-import` folder gone) |
| Guards untouched | main-only, folder-absent and no-caller checks unchanged; the suite's three guard cases pass |
| R4 no dispatch | the PR runs no workflow; the production retire is the owner question asked with Gate 2 (plan §3) |
| Staging proof | not verified on staging: deploys nothing; Vitest suite referenced as `existing` |
