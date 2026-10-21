# VTID-04017 — W3: CI feedback loop in fix mode — the self-heal child continues on the parent's PR branch

Context: `docs/OPERATOR-AGENT-BUILD-PLAN.md` W3. Until now a CI failure on a Dev Autopilot PR went: watcher → `bridgeFailureToSelfHealing` → triage → `revertExecutionPR` (for stage `ci`: close the PR, delete the branch) → child execution from the same plan on a fresh clone of `main`, opening a NEW PR — the whole first attempt thrown away, the CI evidence (VTID-04005) only ever a hint in the prompt. Run #4's child (#3379) is the shape of that loop. Two further defects were latent on that path: the child's prompt referred to a branch that no longer existed, and the PR-flood guard in `runExecutionSession` would refuse any child whose parent row still carried a `pr_url` (the parent stays `reverted`, which the guard does not exclude).

Fix mode: when the failed stage is `ci`, the parent ran on the AGENT executor, it has an open PR (`pr_number` + `pr_url` + `branch`) and the bridge is not in `DEV_AUTOPILOT_DRY_RUN`, the PR is left open and the child row carries `metadata.fix_mode = { branch, pr_number, pr_url, parent_execution_id }` (alongside the inherited `executor`/override and `parent_failure`, the CI log excerpts). The agent runner clones that branch, fetches the base to diff against, builds a fix-mode task prompt (branch, PR, the PR's files, the CI evidence, attempt N of M), lets the agent reproduce and fix, re-runs the post-hoc checks on the WHOLE PR diff (scope, coverage, tsc, paired jest), requires that this run actually edited something, commits, fast-forward-pushes onto the same branch, and returns the same PR so the watcher keeps tracking it; on green the watcher merges and marks the parent `self_healed` exactly as before. Rounds stay capped by `max_auto_fix_depth`; escalation in fix mode leaves the PR open and names it in the event. Per-run agent usage/cost is appended to the finding's `dev_autopilot_outcomes` row (`metadata.agent_runs[]`, `agent_cost_usd_total`) — no schema change.

AC-1 — `isFixModeEligible` is true only for stage `ci`, an agent-executor parent, an open PR (number, url, branch) and not DRY_RUN; `buildFixModeInfo`/`parseFixMode` round-trip and reject malformed shapes.
TEST: services/gateway/test/vtid-04017-fix-mode.test.ts

AC-2 — The PR-flood guard's one exception: a fix-mode child targeting the prior open PR (by number or url) is not blocked by it; any other open PR, or a row without `fix_mode`, still blocks.
TEST: services/gateway/test/vtid-04017-fix-mode.test.ts

AC-3 — `spawnChildExecution` writes `fix_mode` on the child row next to the inherited executor/override and `parent_failure`; without fix mode the row is unchanged.
TEST: services/gateway/test/vtid-04017-fix-mode.test.ts

AC-4 — `bridgeFailureToSelfHealing`: for an agent parent at stage `ci` the revert helper is not called (no PR close, `revert_pr_url` null), the child is spawned with `fix_mode`, `bridge_fix_mode:true` is recorded on the parent and the `self_heal_injected` event carries `fix_mode`/`fix_branch`/`fix_pr_number`; a single-shot parent still takes the pre-existing revert path; escalation in fix mode leaves the PR open (`pr_left_open` on the event).
TEST: services/gateway/test/vtid-04017-fix-mode.test.ts

AC-5 — The fix-mode task prompt names the branch and PR, lists the PR's files, carries the CI evidence, states the attempt count, forbids starting over / reverting the intent / opening a new PR, and forbids deleting or skipping a test to get green.
TEST: services/gateway/test/vtid-04017-fix-mode.test.ts

AC-6 — Workspace: `prepareWorkspace({ existingBranch })` clones the PR branch and does not `checkout -b`; `fetchRefSha` fetches the base shallowly; `listChangedFilesSince` diffs the working tree (untracked included) against it; `commitAndPush({ force:false })` pushes a plain fast-forward; defaults unchanged.
TEST: services/gateway/test/vtid-04017-fix-mode.test.ts

AC-7 — `appendAgentRun`/`recordAgentRunUsage` append a per-run usage record (tokens, cost via `estimateCost`, turns, fix rounds, checks refused, fallback, fix_mode, outcome) to the finding's latest outcome row, de-duped by execution id, capped, with a running cost total; failures are swallowed.
TEST: services/gateway/test/vtid-04017-fix-mode.test.ts

OASIS_PROOF: additive payload fields only — `dev_autopilot.execution.self_heal_injected` gains `fix_mode` (+ `fix_branch`, `fix_pr_number` when true) and `dev_autopilot.execution.escalated` gains `pr_left_open` in fix mode; no topic, schema or consumer change. Pinned by AC-4 (the test reads the emitted events' payloads). Live check after the first fix-mode retry on staging: `select payload->>'fix_mode', payload->>'fix_pr_number', payload->>'child_execution_id' from oasis_events where topic = 'dev_autopilot.execution.self_heal_injected' order by created_at desc limit 5;`.

Not verified here: a live fix-mode retry on staging — that needs a real agent PR whose CI fails (Test Run #6 in the plan: deliberately ask for a change whose first attempt breaks a paired test, then watch the same PR go green without a second PR).
