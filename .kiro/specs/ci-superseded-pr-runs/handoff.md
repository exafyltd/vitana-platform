---
slug: ci-superseded-pr-runs
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-02T15:10Z
vtids: []
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
