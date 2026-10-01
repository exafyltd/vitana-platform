# VTID-04468: live operator test on staging (2026-09-24)

This test ran after the VTID-04465/04466/04467/04472 merge (#3650, `042114a7`), with the staging gateway on that code and the executor image rebuilt from `main` (run #25). The kill switch was off and auto-approve was off (12:41 UTC). Every request went through the staging Operator Console (`POST /api/v1/operator/chat`) as the `operator-autopilot` service account.

## Run 1: cdce6e55 (VTID-04287, old executor image)

- The agent first edited at turn 18 and called finish at turn 50. The runner's tsc was clean and jest passed. The branch was pushed and the run was held at `awaiting_approval`.
- The diff was reviewed and approved from the console (`autopilot_approve_execution`), which opened #3667.
- The staging watcher saw `ci_passed` at 14:44:02, `llm_review_passed` at 14:44:08 and `pr_merged` at 14:44:11 (`a15dd0b1`). Staging deploy run 611 started at 14:44:13. The run was marked `deployed` at 14:53:37 and `completed` at 14:58:37 after the verification window. The pipeline itself closed VTID-04287 as `success`.

TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts (the same path, over the in-memory platform)

## Run 2: b3d4f2b3 (VTID-04492, new image, open-ended request)

| Signal | Observed |
|---|---|
| Memory context | `runner:memory_context enabled=true chars=17129 recall=10` |
| Code index | `exafyltd/vitana-platform@cb212074`, 50,833 nodes |
| Starting map (VTID-04466) | `runner:starting_map: 3782 chars from the code index` before turn 1 |
| Commit nudge (VTID-04466) | `exploration commit nudge: 42 turns without an edit` at turn 42 (35% of 120) |
| First edit | turn 48, 6 turns after the nudge |
| Repeated-read guard | 4 identical `read_file` calls refused |
| Finish | turn 61; runner tsc clean, jest pass; pushed `185c5eca`; `awaiting_approval`, 6 files, no PR |
| Wall clock | 14:30:42 queued, 14:39:44 held (9 min) |

TEST: services/gateway/test/vtid-04466-exploration-budget.test.ts

The diff is a correct fix. `voice.latency.measured` labelled every non-Nova turn `vertex/gemini-2.0-flash-exp`; it now uses a pure `latencyProviderLabel()` with a test for each upstream.

**Not approved, on purpose.** The row has `claimed_env=production`: the production gateway claimed it. Production's watcher would merge it, then wait for a production deploy that a merge to `main` never produces, and revert it. That happened twice on 2026-09-22 (#3585, #3594). The fix is VTID-04497, in this PR.

## Findings

1. The production gateway claims about 2/3 of executions from the shared table and reverts what it merges. The fix is VTID-04497. It only takes effect when production is promoted, which is the owner's call.
2. The exploration budget works as designed: the nudge fired on the exact turn and the agent edited 6 turns later. Whether the nudge caused the edit cannot be shown from one run.
