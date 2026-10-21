# VTID-04730 — read-only E2E: the login setup never saves the test account's role

Measured on staging read-only runs: role_preferences for the shared test
account flipped to developer at 2026-09-28 20:40:36 (47 s into run 36480785482)
and 2026-09-29 07:04:25 (6 s after "Run E2E tests" started in run 36534424063).
Cause: the auth-developer setup project opens the Command Hub, whose boot
saves the best allowed role (POST /api/v1/me/active-role). The e2e/auth
setup files imported `test` from @playwright/test, so the VTID-04689 guard
never ran there. loginAsRole's own save was already skipped under E2E_READONLY.

AC-1 Every e2e/auth/*.setup.ts takes `test` from ../fixtures/readonly-test.
TEST: grep -L "from '../fixtures/readonly-test'" e2e/auth/*.setup.ts  (no output)

AC-2 No file in the 16 run projects imports `test` from @playwright/test directly.
TEST: grep -rlE "import \{[^}]*\btest\b[^}]*\} from '@playwright/test'" e2e --include=*.ts (only fixtures/readonly-test.ts, node_modules and ios-suites, which no project runs)

AC-3 The setup projects still load.
TEST: npx playwright test --list --project=auth-developer --project=auth-community

AC-4 After the next read-only 16-project run on staging, role_preferences.updated_at for the test account is unchanged.
UI: role_preferences row read before and after the run (recorded in the PR)
