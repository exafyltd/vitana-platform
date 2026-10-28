# Command Hub Operator Console — end-to-end recovery, 2026-09-21

**VTID-04221.** Written after the first day the Operator Console's own pipeline
completed tasks end to end (11 of 16 in one batch). Everything below was
verified live this session, not inferred; file references are to `main` at
`a8a8e84`. Read this before touching the Dev Autopilot executor, watcher,
reconciler or bridge.

## 1. Where we started

Two prior sessions reported "dozens of tasks, every one failed". Live state at
the start of this session (four-day window of `dev_autopilot_executions`):

| status | rows |
|---|---|
| failed | 67 |
| awaiting_approval | 21 |
| reverted | 10 |
| completed | 4 |

Five blockers stacked, so fixing any one alone still produced zero completions:

1. **Every auto-merged execution was reverted from `main` 30 minutes later.**
   `AWS-STAGE-DEPLOY-GATEWAY.yml` writes the deploy event as
   `staging.deploy.completed`; the watcher and reconciler only queried the
   GCP-era `deploy.gateway.success` family. No AWS deploy ever matched, the
   deploying-stage reconciler timed out, and `revertExecutionPR` auto-merged a
   revert of correct, CI-green work (141c4e4b / f64f22e2 on 2026-09-20). Fixed:
   VTID-04215.
2. **The approval gate guaranteed zero completions on staging.**
   `OPERATOR_PR_APPROVAL_REQUIRED=true` holds every agent run at
   `awaiting_approval` with no PR; nobody was calling
   `POST /api/v1/dev-autopilot/executions/:id/approve`. The endpoint works
   (VTID-04216 used it for 16 approvals and 5 rejections).
3. **The executor image was stale.** Fixes merged to `main` do nothing until
   `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` is dispatched by hand.
4. **The executor navigates blind.** Seven grep-shaped primitives, no
   RepoWise/Graphify, no memory of prior runs (see §4).
5. **The loop cannot tell a truncated reply from a prose reply**, so a DeepSeek
   completion cut off at the output cap counts as "refused to use tools".

## 2. What shipped today

| VTID | PR | Change | State |
|---|---|---|---|
| 04215 | #3502 | `dev-autopilot-deploy-topics.ts`: env-aware deploy topics, normalizer, exact `merge_sha` match + queued-merge fallback; watcher and reconciler rewired; drift test reads both workflow files | merged, live on staging |
| 04216 | — | Executor image rebuilt (run 17); 5 hand-merged rows rejected, 16 approved through the real endpoint | done |
| 04217 | #3521 | Fix mode merges the base branch first (`mergeBaseIntoBranch`), hands conflict markers to the agent, refuses to push any marker; real-git round-trip test | merged; executor image rebuild run 18 dispatched |
| 04218 | #3522 | `transitionStatus` returns whether a row actually moved (`return=representation`); the CI watcher refuses to merge when `ci→merging` did not record; `reconcileCi`/`reconcileMerging` stamp `metadata.merge_sha` | merged |
| 04219 | #3523 | `main` was red: #3508 and #3513 (both agent PRs, both green alone) broke each other; one-line test reconciliation | merged |
| 04220 | #3524 | `gatewayBaseUrl()`: the verifying-stage `/alive` probe no longer defaults to the deleted GCP host; the self-healing probe no longer defaults a staging process to production | open |

## 3. Live evidence: the 16-execution batch

Approved 12:00 UTC through the real endpoint. Outcome by 13:55 UTC:

| outcome | rows | what happened |
|---|---|---|
| completed, VTID terminalized `success` | 11 | `ci → merging → deploying → verifying → completed`, ledger closed by the pipeline itself |
| failed_escalated / reverted (ci stage) | 4 | `merge conflict (dirty)`: a sibling PR merged first and touched the same file (`app.js`, `operator-bootstrap-pack.ts`) |
| failed_escalated (ci stage) | 1 | a real failing check (`Gateway Service Tests`) |

Three fix-mode children (546373b0, d2f8af0f, 6fd8ed30) were spawned for the
failures. They run on the pre-VTID-04217 image and cannot resolve a conflict;
they are the first live exercise once run 18's image is picked up.

Two incidents during the batch, both recorded because they are reproducible:

- **Aurora write-freeze, 12:03–13:16 UTC** (another session's routine): the
  watcher kept merging on GitHub (11 PRs) while every state PATCH was refused,
  and the deploy events of those merges were lost. Recovery needed one manual
  staging deploy to emit a fresh event. VTID-04218 closes the merge-without-
  record half; the lost-event half is what the queued-merge fallback in
  VTID-04215 covers.
- **Two green PRs broke `main` together** (#3508 added a line-count test,
  #3513 added a line to the same pack). The watcher re-checks each PR's own CI
  before merging; nothing checks the PR against current `main`. See §4.B.

## 4. What still needs building, ranked

Each item names the file to open. Ranked by how many executions it costs per
batch today.

### A. Executor capability (why the agent burns 120 turns)

1. **RepoWise + Graphify in the executor.** `Dockerfile.job` installs neither
   (no python, no `pip install repowise graphifyy`, no `codeintel-src` COPY);
   `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` stages nothing and checks out
   shallow. The gateway `Dockerfile` (VTID-04118) has the working recipe:
   stage both repos, `pip install`, `graphify update . --no-cluster`,
   `repowise init --no-prose -y`. Reuse it, then expose
   `runRepowise`/`runGraphify` (`codeintel-readonly.ts:88,115`) as two agent
   tools with the `dev_repowise`/`dev_graphify` schemas from
   `gemini-operator.ts:716-758` (`parameters` → `inputSchema`), pointed at the
   run's clone (`repowise update` / `graphify update .` on the clone at run
   start; the baked index is the warm cache). Add a prompt rule: query the
   index before any `search_text` sweep. Note `ALLOWED_CODEINTEL_REPOS`
   defaults (`/app`, `/app-vitana-v1`) do not match where the gateway image
   indexes (`/repo-platform`, `/repo-vitana-v1`); the env vars are
   load-bearing.
2. **Memory recall in the executor.** `recallDevMemory(query, repo, {limit})`
   (`dev-agent-memory.ts:110`) plus `diversifyRecallHits`/`renderDevMemoryBlock`
   (`dev-memory-ranking.ts`) already exist and the executor already *writes*
   `task_outcome`/`gotcha` rows (VTID-04025). Nothing under `autopilot-agent/`
   reads them. Call recall with the plan text in `buildAgentTaskPrompt` and
   inject the block; also surface the finding's own
   `dev_autopilot_outcomes.metadata.agent_runs[]` (last 20 runs with
   error/turns/cost) so a retry knows what the previous attempt did.
3. **Stop reason.** `llm-router.ts` never reads `finish_reason` (DeepSeek,
   `:755-763`) and drops `stopReason` from Bedrock (`:906-915`, available at
   `providers/bedrock.ts:210`). `LLMRouterResult` has no truncation flag, so
   `agent-loop.ts:218-227` counts an output-cap-truncated completion as a
   "text without tools" strike. Expose `stopReason`/`truncated`; on
   truncation shrink `historyCharBudget` and retry the turn instead of
   counting a strike. Also: the DeepSeek adapter reads only `tool_calls[0]`
   (`:767`) — a multi-call turn silently loses calls.
4. **Conflict resolution** — shipped (VTID-04217). Verify on the three children.

### B. Pipeline correctness (why a correct merge still fails)

5. **Verification blast radius is tenant-wide.** `analyzeVerificationWindow`
   (`dev-autopilot-watcher.ts:355-381`) fails an execution on *any*
   `status=error` OASIS event carrying a vtid in a 5-minute window
   (`VERIFICATION_WINDOW_MS`, `:77`), excluding only `dev_autopilot.*`,
   `self_healing.*`, `cicd.*`, `vtid.lifecycle.*`, `operator.execution_onramp.*`.
   `llm.call.failed`, `knowledge.search.error`, `staging.deploy.failed` (another
   commit's deploy!) all count, and a fail here reverts the merge. Scope it:
   compare the window's error rate against the 5 minutes before the merge and
   fail only on a rise; and exclude `BOOTSTRAP-*` vtids and deploy topics.
6. **Post-merge failures can never enter fix mode.** `isFixModeEligible`
   (`dev-autopilot-bridge.ts:422-432`) requires stage `ci`; every
   `deploy`/`verification` failure reverts and spawns a single-shot child that
   the flood guard (`dev-autopilot-execute.ts:1597-1616`) then blocks because
   the reverted parent keeps its `pr_url` and `reverted` is not in the
   exclusion list. Each round burns a triage call and a concurrency slot until
   `max_auto_fix_depth`. Either exclude `reverted`/`failed`/`failed_escalated`
   from the prior-PR query or ask GitHub whether the PR is actually open.
7. **Ledger terminalization has holes.** `reverted` and `failed_escalated`
   are written with raw PATCHes (`dev-autopilot-bridge.ts:789-797, 850-858`)
   that bypass `applyExecTerminalSideEffects`, and the ledger write is
   fire-and-forget twice (`dev-autopilot-watcher.ts:411`,
   `dev-autopilot-execute.ts:2077`). Route every terminal write through
   `patchExecution` and make the ledger PATCH awaited with one retry.
8. **Task-def pins.** `GATEWAY_URL` and `VITANA_ENV` are not pinned by
   `AWS-STAGE-DEPLOY-GATEWAY.yml`; both are inherited from whatever the live
   task def carries. Pin them the way `OPERATOR_*` flags are pinned, with a
   pin test like `vtid-04006-staging-onramp-executor-pinned.test.ts`.
9. **Merge safety.** Require the PR branch to be up to date with `main` before
   the watcher merges (GitHub "require branches to be up to date" or a merge
   queue), or have the watcher merge `main` into the branch and wait for CI
   once more. Today two independently green PRs can break `main` together.

### C. Throughput (why a batch of 30 takes all day)

10. **The concurrency cap counts the whole post-merge tail.**
    `countRunningExecutions` (`dev-autopilot-execute.ts:421-427`) counts
    `running, ci, merging, deploying, verifying` against
    `dev_autopilot_config.concurrency_cap` (default 2). Two rows parked in
    `verifying` block all new dispatch. Count `running` only (the cap exists
    to bound agent tasks and LLM spend; CI and deploys cost nothing), and let
    a separate, larger cap bound the tail if wanted.
11. **Approval gate policy for batch runs.** `OPERATOR_PR_APPROVAL_REQUIRED`
    is the right default for the console; for a deliberate batch test it makes
    "0 completed" the expected result. Either approve through
    `autopilot_approve_execution` from the console or flip it off for the run.

### D. Model policy (owner decision, not made here)

12. DeepSeek Flash primary is standing policy. Every capability failure class
    above (re-reading identical files, prose stalls, output-cap truncation) is
    model behaviour. `AGENT_PRIMARY_PROVIDER`/`AGENT_PRIMARY_MODEL` exist for a
    controlled experiment; one batch on `bedrock` /
    `eu.anthropic.claude-sonnet-4-6` on the executor task def would show
    whether the harness or the model is the ceiling.

## 5. Operating notes

- The approve/reject endpoints work and are the only correct way to close a
  held row; a hand-merged branch leaves the row stuck forever (the five from
  the previous session were rejected today to close them).
- Nine hand-made PRs from the previous session (#3480–#3497) duplicate agent
  work that has since merged (VTID-04191↔04196, 04185↔04211, 04187↔04203,
  04186↔04200, 04165↔04202, 04181↔04205, 04173↔04197, 04175↔04210,
  04174↔04204). Close them.
- Do not run a batch during a database write-freeze; the watcher will merge
  on GitHub and record nothing (VTID-04218 now refuses the merge, but the
  deploy events are still lost).

## 6. Signals to watch

- `dev_autopilot.execution.deployed` with `deploy_topic: "staging.deploy.completed"` and `matched_by: merge_sha` (VTID-04215 working).
- `dev_autopilot.execution.pr_merged` from the reconciler carrying `merge_sha` (VTID-04218).
- A fix-mode child's steps showing `runner:merge_base → conflict: …` followed by edits and a push with no `runner:conflict_markers` failure (VTID-04217).
- Watcher log line "ci→merging not recorded; refusing to merge" during any future write outage, with no unrecorded merge on `main`.
