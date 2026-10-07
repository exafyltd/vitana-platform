# VTID-04947 (+ VTID-04946) — acceptance

AC-1: CLAUDE.md carries the Autonomy Contract (two owner gates) above Part 1, and IF-THEN 10 no longer says "stop and ask".
TEST: grep -c "AUTONOMY CONTRACT — TWO OWNER GATES" CLAUDE.md → 1; grep -c "IF\*\* uncertain → \*\*THEN stop and ask" CLAUDE.md → 0 (outputs/grep.txt)

AC-2: The plan-sparring skill sends one Gate 1 message and runs to Gate 2 without asking (step 6).
TEST: grep -n "## 4. Gate 1\|## 6. After the yes" .claude/skills/plan-sparring/SKILL.md (outputs/grep.txt)

AC-3: The e2e test user's password no longer appears in any tracked file; every e2e entry point reads TEST_USER_PASSWORD from the environment.
TEST: git grep -c "VitanaE2eTest2026" → no matches (outputs/grep.txt); node --check on the edited .mjs runners passes (commands.log)

AC-4: No workflow that runs the edited e2e files relied on the removed fallback.
TEST: grep TEST_USER_PASSWORD in ANDROID-DEVICE-E2E, E2E-ORB-MONITOR, E2E-TEST-RUN, MOBILE-DEVICE-E2E, MORNING-SYSTEM-HEALTH-CHECK, SCREEN-LOAD-TIMING → each passes it from secrets (outputs/grep.txt)

OASIS_PROOF: n/a — documentation and test-harness change, no runtime OASIS events.
