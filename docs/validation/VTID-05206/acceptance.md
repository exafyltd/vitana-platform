# Acceptance - VTID-05206 closing record (lane new-member-welcome/new-member-card-optin, executing -> in-review)

Change types: Tooling/docs.

This PR only records, in the lane file, that the lane's code already merged (exafyltd/vitana-v1#1441, #1444) and that its
migration was applied by owner instruction. It deploys nothing in vitana-platform, so staging-tests.json holds only the
read-only `/alive` check. The feature itself is proven by the vitana-v1 PRs and their staging spec.

VALIDATION_PROFILE: gateway_backend (the only profile besides command_hub_frontend; no gateway code changes in this PR)

AC-1: The lane moves `executing` -> `in-review` through a legal edge, with `claimed_by` set to the committing session and
`next_actor: kiro`; `seat`, `paths`, `executor`, `reviewer_seat`, `depends_on` and `vtid` are unchanged.
  TEST: node scripts/collab/queue.mjs validate --base origin/main --head HEAD --repo . (outputs/validate.txt)

AC-2: The lane log names the merged code (#1441, merge b73e6d298f59...) and the staging spec fix (#1444, merge 704b5def4cfa...),
and both shas match what GitHub reports.
  TEST: gh api repos/exafyltd/vitana-v1/pulls/1441 and pulls/1444 (outputs/gh-merge-shas.txt)

AC-3: The migration entry is in collaboration.md section 7d form and matches the real run (success, "Apply OK, status 201").
  TEST: gh run view 41051243641 --repo exafyltd/vitana-v1 --log (outputs/migration-run-excerpt.txt, outputs/migration-run-summary.json)

AC-4: The change stays inside the lane file and this evidence directory.
  TEST: node scripts/collab/queue.mjs scope-check --base origin/main --head HEAD --repo . --branch kiro/close/new-member-welcome/new-member-card-optin-i1 (outputs/scope-check.txt)

AC-5: Every required governance check passes before push.
  TEST: node scripts/collab/preflight.mjs (outputs/preflight.txt)
