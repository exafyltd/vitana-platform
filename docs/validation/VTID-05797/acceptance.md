# VTID-05797 — acceptance evidence

Scope: CI wiring for the VTID-05622/05670 staging group-chat check. Sparring record: `plan-sparring.md` (abaf654db295dd732, converged, owner Gate 1 "yes"). Command log: `commands.log`; outputs in `outputs/`.

AC-1: The group pair (STAGING_GROUP_TEST_EMAIL / STAGING_GROUP_TEST_PASSWORD) is passed only into the Playwright env built by runPlaywright.
TEST: node --test scripts/ci/staging-verify/workflow.test.cjs (assertion (a)) — outputs/workflow-test.txt: 11 pass, 0 fail.

AC-2: The group pair is deleted from process.env at the start of the verify path, before any git, gh, npm or playwright command.
TEST: node --test scripts/ci/staging-verify/workflow.test.cjs (assertion (b)) — outputs/workflow-test.txt.

AC-3: The shared TEST_USER_* pair in the Playwright env is unchanged.
TEST: node --test scripts/ci/staging-verify/workflow.test.cjs (assertion (c)) — outputs/workflow-test.txt.

AC-4: The workflow passes the two group secrets to the verify step only.
TEST: node --test scripts/ci/staging-verify/workflow.test.cjs (assertion (d)) — outputs/workflow-test.txt.

AC-5: No regression in the rest of the staging-verify tooling.
TEST: node --test scripts/ci/staging-verify/*.test.cjs scripts/ci/staging-verify/*.test.mjs — outputs/staging-verify-all-tests.txt: 123 pass, 0 fail.

AC-6: The VTID-05622/05670 group-chat check passes on staging with the group account. Not claimed before merge: it runs only after merge, as STAGING-VERIFY community-app on the merge commit, and only once the owner has confirmed the three pre-merge items in the PR body.
TEST: STAGING-VERIFY community-app on the merge commit (post-merge; pending).
