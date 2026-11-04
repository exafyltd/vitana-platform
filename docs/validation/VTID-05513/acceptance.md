# VTID-05513 — Acceptance (platform: superseded PR runs cancel per PR)

Scope of this PR: the per-PR concurrency block on the 38 PR-triggered workflows declared by the lane, and nothing else.
PR-GATE.yml, PLAN-SPAR.yml, AWS-PROD-*.yml, UNIT.yml, TEST-SUITE.yml, PHASE-2B-DOC-GATE.yml and CALENDAR-REGRESSION.yml are not changed.

AC-1 — Each of the 38 lane workflows has the block once, with cancel-in-progress set only by pull_request events
  Verified by: commands.log (grep count of 38 blocks, 0 extra concurrency keys).
AC-2 — Push-to-main and scheduled runs are never cancelled by the block
  Verified by: the block's cancel-in-progress expression is ${{ github.event_name == 'pull_request' }} (commands.log).
AC-3 — Required check names are unchanged
  Verified by: job and workflow names are byte-identical (diff contains only the six-line block, commands.log).
