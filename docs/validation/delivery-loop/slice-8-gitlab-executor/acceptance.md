Change types: Backend, Integration.
# Delivery loop, slice 8: GitLab-native self-healing executor and bridge guards

No VTID. `plan(delivery-loop-engine)` (the `plan(delivery-loop)` of MR !79) cannot be sparred: PLAN-SPAR answers HTTP 401 since 2026-11-18
22:23 UTC (`.kiro/specs/delivery-loop-engine/registration-blocked.md` on the plan PR), so no lane has a VTID, and VTIDs come only from CI
PLAN-SPAR. Plan lane: `delivery-loop-engine/gitlab-executor`. Nothing here is switched on: the loop, its executor and the executor's
GitLab token are in no task definition.

Owner instruction 2026-11-19, items 4 and 5: *"Implement the GitLab failure adapter against the existing self-healing architecture, but
make it GitLab-native. Do not route GitLab failures through GitHub PRs."* and *"Add guards so the bridge cannot close PRs, delete
branches, or alter an MR-owned branch. It must fail safely for unsupported execution states."*

## What exists now

A failed GitLab merge-request pipeline that the delivery loop decides to repair (heal.ts, drive.ts) becomes a Dev Autopilot execution on
that merge request's own branch:

| Step | Where | What |
|---|---|---|
| hand-off | `delivery-loop/dev-autopilot-gateway.ts` | the `dev-autopilot` executor of the loop's port. Repairs only; refuses intake, rework, `main`, the target branch and any branch the loop does not own. Bound in runtime.ts; on only with `DELIVERY_LOOP_EXECUTOR=dev-autopilot`. |
| queue | `dev-autopilot-gitlab-repair.ts` | one inert carrier finding per merge request (status `auto_archived`, scanner `delivery-loop`, no VTID), one plan version per attempt (`files_referenced: []`), one `cooling` execution per dispatch key, written in one insert with `metadata.host = 'gitlab'` and the target. No `branch`, `pr_url` or `pr_number`. Nothing is written for an invalid target, while the executor's kill switch is on, or when it cannot be read. |
| claim | `backgroundExecutorTick` (unchanged) | the existing claim, kill switch, concurrency and outage gates. The overlap check makes no GitHub call (empty files). The in-flight unique index allows one repair per merge request at a time. |
| run | `runExecutionSession` → `run-agent-execution.ts` | a GitLab row skips the GitHub PR-flood guard and the single-shot path and runs on the agent runner in GitLab mode: clone the merge request's branch from GitLab (`oauth2` URL with the executor's own token `DEV_AUTOPILOT_GITLAB_TOKEN`) at the head that failed (a moved branch is refused before the model runs), read the merge base (nothing merged), fix-mode prompt with the failing job's output, the same scope, test-coverage, tsc and jest checks, then ONE commit pushed with `--force-with-lease=refs/heads/<branch>:<failing head>` (every accepted push is a fast-forward; never a bare `--force`). No PR contract, no evidence files in the merge request's tree, no PR, no approval hold. |
| end | `applyExecutionResult` → `applyGitlabResult` | pushed: `auto_archived` with `metadata.gitlab_result` (the one status no watcher, reconciler, ledger helper or self-healing tick acts on), event `dev_autopilot.execution.gitlab_pushed`. Anything else: `failed`, never bridged. Both writes are conditional on `running`. GitLab's pipeline judges the push; the loop's reconciler reads it (heal.ts). |

## Bridge guards (dev-autopilot-bridge.ts)

- **G1**, first after the row is loaded: a GitLab-hosted execution (any `host: 'gitlab'` or any `gitlab` block, valid or not) is refused,
  `unsupported_execution`, with no triage, no GitHub call and no write.
- **G2**, after the idempotency check (so `already_bridged` and the callers' ledger handling stay as they are): a status outside
  `BRIDGEABLE_STATUSES` = {failed, running, ci, merging, deploying, verifying}, the states today's callers leave a failed row in, is refused,
  `unsupported_state`, before the first write.
- Behind G1, each destructive helper refuses a GitLab row on its own: `revertExecutionPR` (no PR close, no branch delete, no revert PR),
  `isFixModeEligible` (false), `spawnChildExecution` (no child row).

## Acceptance criteria and the tests that prove them (all red on the base: outputs/red-on-base.txt)

AC-1 **Nothing GitHub happens for a GitLab repair.** End to end over the operator suite's in-memory database and GitHub: queued, claimed,
cloned from GitLab at the failing head, fixed, pushed with the lease, archived; zero GitHub calls, zero GitHub pushes, zero PRs, zero
triage, zero ledger rows; a CI watcher tick afterwards takes nothing. TEST: vtid-04465 "GitLab-native repair" (4 scenarios), plus the
suite's own afterEach (no external call at all).

AC-2 **The branch gets the repair and nothing else.** One commit on the failing head; a branch that moved is refused before the model
runs; a run that changes nothing pushes nothing; no merge of the target branch; the lease is the failing head and a stale lease is
refused by the remote. TEST: vtid-04465 scenarios 1 to 3; autopilot-agent-workspace-gitlab.test.ts (9).

AC-3 **The bridge cannot close a PR, delete a branch or touch an MR-owned branch, and refuses unsupported states before any write.**
Live settings (DRY_RUN off, a GitHub token): every request recorded. TEST: dev-autopilot-bridge-gitlab-guards.test.ts (25): G1 in three
statuses and for a malformed claim; the three helpers; G2 for ten states; `already_bridged` unchanged; the six supported states still
bridge. The existing bridge, fix-mode and merge-conflict suites stay green (22, 16, 11).

AC-4 **One attempt is one execution; one merge request is one repair at a time.** TEST: dev-autopilot-gitlab-repair.test.ts (15): the
same dispatch key answers its execution and writes nothing; a second in-flight repair of a merge request is `executor_busy`, retryable;
invalid targets, the kill switch, an unreadable config and a missing database write nothing.

AC-5 **The carrier finding is inert.** Status `auto_archived` (auto-approve and planning read `new`; the activation reaper reads
`activated`, execute.ts `activationReaperTick`), no `activated_vtid` (no cancel, failure or completion closes a VTID), files empty (no
overlap call). TEST: dev-autopilot-gitlab-repair.test.ts; vtid-04465 scenario 1.

AC-6 **Fails closed without its token, its switch or a valid target.** TEST: vtid-04465 scenario 4 (no token: nothing cloned);
autopilot-agent-gitlab-target.test.ts (31: target validation, the token never in an error, the executor token is not the loop's);
delivery-loop/dev-autopilot-gateway.test.ts (13: repairs only, owned branches only, off without `DELIVERY_LOOP_EXECUTOR`).

AC-7 **The loop sends one dispatch key per attempt.** Found while wiring: the port carried only the work key, shared by every attempt at
one failure, so an executor that deduplicates (as this one must) would have answered attempt 2 with attempt 1's finished execution.
`TaskRequest.dispatch_key` is now the intent's key. TEST: delivery-loop/heal.test.ts "hands the executor one dispatch key per attempt".

AC-8 **Nothing else moved.** Full gateway suite (outputs/full-gateway-suite.txt): 1811 suites, 30559 tests, 30497 passed, 2 failed, both
pre-existing (storage-provider, vtid-04226). The operator pipeline suite 75 of 75 (71 existing + 4 new), role separation 105, customer
support 25, the locked source-type list 78, delivery-loop 346. tsc clean (outputs/tsc.txt).

## Decisions taken (the conservative option each time)

1. End status after a push: `auto_archived` with `metadata.gitlab_result`, not a new status. A new status needs a migration (an owner
   stop) and would be a state every reader must learn. The investigation found `auto_archived` is read by no watcher, reconciler,
   ledger helper or self-healing tick, and reconcileCi already uses it for "handled elsewhere".
2. The carrier finding is `auto_archived` with no VTID, so nothing can auto-approve it, reap it into a GitHub execution or close a VTID.
3. No merge of the target branch into the merge request (GitHub fix mode does merge `main`): a repair adds exactly one commit.
4. A lease push, not a plain push: the remote checks the head atomically, so a branch somebody moved is never written.
5. The executor gets its own token (`DEV_AUTOPILOT_GITLAB_TOKEN`, write_repository); the loop keeps its read token.
6. DRY_RUN does not pretend a GitLab push (a pretended push would make the loop wait for a pipeline that never runs).
7. Repairs only. Intake would open new merge requests, which needs a VTID path for loop-created work that does not exist.
8. G2 sits after the idempotency check, so the watchers' ledger handling for already-bridged rows is unchanged.

## Found, not changed (pre-existing, outside this change)

- The reconcilers pass `merging`, `deploying` and `verifying` as `failure_stage`, which the column's CHECK refuses (20260416100000_dev_autopilot.sql:171),
  so those bridge PATCHes fail silently.
- The bridge's status PATCHes have no status precondition and their results are not checked (G2 limits who reaches them).
- Dev Autopilot does not read EXECUTION_DISARMED or AUTOPILOT_LOOP_ENABLED; only its own kill switch stops it. The enqueue checks that
  kill switch; the loop dispatches only at L3 with execution armed.

## Not done, and what it needs

- **Not run against a real GitLab or a real executor task.** The end-to-end proof is the operator suite (real code, in-memory
  database, a git-only GitLab fake). The slice 7 rehearsal against the real GitLab project still uses its stub worker.
- **The executor task has no GitLab token.** `DEV_AUTOPILOT_GITLAB_TOKEN` and `GITLAB_API_URL` must be added to the
  `vitana-autopilot-executor` task definition, which only `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` manages (a production workflow: owner
  step), and to the staging gateway for the in-process fallback. Until then a GitLab repair fails closed (`gitlab_not_configured`).
- **Not verified on staging**: no VTID, so there is no change suite (`docs/validation/<VTID>/staging-tests.json`), and the staging
  gateway service `vitana-gateway` is at desired 0.
- Switching on: `DELIVERY_LOOP_ENABLED`, `DELIVERY_LOOP_EXECUTOR=dev-autopilot`, autonomy L3 with execution armed (owner, stop 13).
