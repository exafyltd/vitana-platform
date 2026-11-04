---
slug: ci-superseded-pr-runs
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-02T16:31Z
vtids: [VTID-05513, VTID-05514]
sparring_record: .kiro/specs/ci-superseded-pr-runs/sparring/verdict.md
---
# Handoff — ci-superseded-pr-runs

Plan: `plan.md`. Tasks: `tasks.md`. Two lanes, one per repo:
- `v1-superseded-concurrency` (repo `exafyltd/vitana-v1`, executor kiro, seat exafyltd).
- `platform-superseded-concurrency` (repo `exafyltd/vitana-platform`, executor kiro, seat exafyltd).

Source change already prepared on a local branch (`ci/superseded-pr-run-concurrency`): v1 commit `74c03b984`,
platform commit `f0a213e490`. Lane commits are rebuilt with the lane trailers after the VTID is allocated.

## Log
### 2026-11-02T15:10Z · kiro-exafyltd-202611021510-092e · drafted
Written on the owner's approval (2 Nov 2026) to cancel superseded PR runs. Protected gate files are excluded.

### 2026-11-02T16:31Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 2 lane(s) got a VTID and are handed to Kiro.
