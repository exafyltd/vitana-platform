# VTID-04950 — platform gate parity (plan Phase 4) — acceptance

AC-1: oasis-operator, oasis-projector, orb-agent, verification-engine and autopilot-executor prod deploys accept `commit_sha`, check it out and verify it.
TEST: npx jest test/vtid-04950-prod-deploy-pin-rollback.test.ts (outputs/jest.txt)

AC-2: the four ECS-service prod deploys capture the live task definition before building and roll back on failure behind PROD_AUTO_ROLLBACK_DISABLED.
TEST: same suite; mutation check (renaming `id: roll` fails 1 case) in commands.log

AC-3: the required `unit` check runs every dependency-free script test (36 cases) instead of printing the pnpm version.
TEST: node --test over scripts/**/*.test.{cjs,mjs} (outputs/unit.txt)

AC-4: CICDL-GATEWAY-CI build and typecheck fail the check on failure; the lint step that could never run (no ESLint config) is removed.
TEST: npm run build (exit 0) and tsc --noEmit (0 errors) on main (commands.log)

AC-5: PR-GATE (scope, sparring record, test weakening, red→green with Jest) runs report-only on platform PRs.
TEST: node --test scripts/ci/pr-gate/__tests__ (15 pass); red→green proof on a throwaway branch: 13 tests fail on base, pass on head (commands.log)

OASIS_PROOF: n/a — CI workflows and tests only, no runtime OASIS events.
