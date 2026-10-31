# Acceptance - VTID-05208 closing record (lane new-member-welcome/grouped-welcome-notifications, parked -> in-review)

Change types: Tooling/docs.

Additional file; the original `acceptance.md` of the feature PR is not changed. This PR only records, in the lane file, that
the lane's code already merged (exafyltd/vitana-platform#4153) and returns the lane through its only legal edge from `parked`.
Nothing deploys, so `staging-tests.json` (the feature's read-only suite) is unchanged.

AC-1: The lane returns `parked` -> `in-review` (its `parked_from`), with `claimed_by` set to the committing session and
`next_actor: kiro`; `seat`, `paths`, `executor`, `reviewer_seat`, `depends_on` and `vtid` are unchanged.
  TEST: node scripts/collab/queue.mjs validate --base origin/main --head HEAD --repo . (outputs/closing-validate.txt)

AC-2: The lane log names the merged code (#4153, merge 0d35512b7ab4...) and the sha matches what GitHub reports.
  TEST: gh api repos/exafyltd/vitana-platform/pulls/4153 (outputs/closing-gh-merge-sha.txt)

AC-3: The change stays inside the lane file and this evidence directory.
  TEST: node scripts/collab/queue.mjs scope-check --base origin/main --head HEAD --repo . --branch kiro/close/new-member-welcome/grouped-welcome-notifications-i1 (outputs/closing-scope-check.txt)

AC-4: Every required governance check passes before push.
  TEST: node scripts/collab/preflight.mjs (outputs/closing-preflight.txt)
