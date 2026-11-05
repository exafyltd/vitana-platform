# VTID-05513 — Acceptance (platform: superseded PR runs cancel per PR)

Scope of this PR: the per-PR concurrency block on the 38 PR-triggered workflows declared by the lane, and nothing else.
PR-GATE.yml, PLAN-SPAR.yml, AWS-PROD-*.yml, UNIT.yml, TEST-SUITE.yml, PHASE-2B-DOC-GATE.yml and CALENDAR-REGRESSION.yml
are not changed. This is a CI-only change that deploys nothing (MERGE_PAYLOAD_PREVIEW: none).

AC-1 — Each of the 38 lane workflows has the concurrency block once.
  TEST: outputs/yaml-parse.txt (38 of 38 parse and carry a concurrency block, 0 bad).

AC-2 — Push-to-main and scheduled runs are never cancelled by the block.
  TEST: outputs/workflow-diff-check.txt and the expression ${{ github.event_name == 'pull_request' }} in each block.

AC-3 — Workflow names, triggers, jobs and steps are unchanged; required check names are unchanged.
  TEST: outputs/workflow-diff-check.txt (RESULT 0: no non-concurrency line changed in any workflow).

AC-4 — No deploy workflow and no protected gate file is changed.
  TEST: outputs/protected-check.txt (RESULT 0).

Live behaviour (superseded runs actually cancel after a newer push) is observed in the GitHub Actions run list after the
merge. It is not claimed here before that observation.
