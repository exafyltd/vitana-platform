---
change_class: standard
---
# plan(delivery-loop-engine): the GitLab delivery loop and a GitLab-native self-healing executor

Author: Kiro 3, seat `exafyltd`, session `kiro-exafyltd-202611181014-b8e5` (Kiro Web), 2026-11-19. This is the `plan(delivery-loop)` named
in GitLab MR !79. The slug is `delivery-loop-engine` because the branch `kiro/delivery-loop` exists, and git cannot hold
`kiro/delivery-loop/<lane>` next to it. Premises are at vitana-platform `79a84a31b5` (`origin/main`) unless marked **WIP**: the
integration branch `kiro/delivery-loop-engine/gitlab-executor` (draft PR), which already holds every lane's code and tests.

**Registration is blocked.** PLAN-SPAR answers HTTP 401 since 2026-11-18 22:23 UTC for every plan, and no approved alternative exists for
a Kiro plan, so this plan cannot be sparred and no lane can get a VTID. The contract, the evidence, the minimal admin fix and the VTID
mapping are in `registration-blocked.md` (outside the sparred block, like this note).

Owner, the mission: *"Implement, not document: 1. AUTONOMOUS INTAKE Connect GitLab task/issue events to Central Loop Engine. 2. DISPATCH
… 3. FAILURE DETECTION Connect GitLab pipeline webhook events to the delivery event system. Ensure authenticated event processing and
durable event recording. 4. AUTONOMOUS REPAIR Implement the delivery.heal writer and connect Dev Autopilot to GitLab pipeline failures.
Failed checks must create repair tasks, dispatch workers and trigger re-execution. 5. AUTOMATED REVIEW … 6. LEARNING … 7. LOOP
ENGINEERING Connect the complete observe → reason → plan → execute → verify → learn → improve cycle. Use AWS-native infrastructure and
GitLab as the delivery authority. No production deployment, no production credentials, no production database changes."*

Owner, 2026-11-19: *"Implement the GitLab failure adapter against the existing self-healing architecture, but make it GitLab-native. Do
not route GitLab failures through GitHub PRs."* and *"Add guards so the bridge cannot close PRs, delete branches, or alter an MR-owned
branch. It must fail safely for unsupported execution states."*

<!-- plan:begin -->
## 0. Premises (vitana-platform `79a84a31b5`)
1. The gateway has no GitLab REST client: `git grep -E "api/v4|PRIVATE-TOKEN|GITLAB_API_(URL|TOKEN)" -- services/gateway/src` finds nothing.
2. GitLab webhook facts: `createGitlabDeliveryStage` (`services/gateway/src/services/gitlab-events/delivery-stage.ts:48`) dedupes per
   `dedupe_key` inside one task (`:71`) and writes through `emitOasisEvent` (`:28`, `:51`). The mapper maps merge request, push and
   pipeline events (`delivery-mapper.ts`); it maps no issue event and gives a failed pipeline no failed-job list.
3. `emitOasisEvent` writes a random row id (`services/gateway/src/services/oasis-event-service.ts:68`) and takes no idempotency key, so
   one fact written by two gateway tasks is two rows. `oasis_events.id` is `uuid PRIMARY KEY` (`supabase/migrations/20251209000000_add_task_stage.sql:10-11`).
4. Nothing writes `delivery.heal.*` or `delivery.improve.*` (`services/gateway/src/types/cicd.ts:1234`); the parent plan assigns them to a
   "gateway loop service" (`.kiro/specs/agentic-delivery/plan.md:371`). No such service exists.
5. Dev Autopilot is GitHub-only. The agent clones `https://x-access-token:<token>@github.com/<owner>/<repo>.git`
   (`services/gateway/src/services/autopilot-agent/agent-workspace.ts:56`), takes owner, repo and base from process constants
   (`run-agent-execution.ts:51-53`) and opens its PR on api.github.com (`run-agent-execution.ts:106-119`).
6. The self-healing bridge takes an execution id (`services/gateway/src/services/dev-autopilot-bridge.ts:271-278`). For a row that is not
   in agent fix mode it closes the GitHub PR and deletes the branch (`revertExecutionPR`, `:395-491`). Fix mode needs a GitHub PR number
   (`isFixModeEligible`, `:532-541`). `bridgeFailureToSelfHealing` (`:646`) checks no execution status before it writes.
7. `dev_autopilot_executions.finding_id` and `plan_version` are NOT NULL (`supabase/migrations/20260416100000_dev_autopilot.sql:136-137`); there
   is no host column. The latest status CHECK and the in-flight unique index (one cooling..verifying execution per finding) are in
   `20261013150000_vtid_05146_autopilot_overlap_hold.sql:23-42,47-59`.
8. `auto_archived` is acted on by nothing: `ledgerStatusForExecution` maps it to no ledger status (`dev-autopilot-execute.ts:2334-2338`),
   the watchers load `ci`, `deploying`, `verifying` and `held_overlap`, the activation reaper (`activationReaperTick`, `:4224`) reads
   findings with `status=eq.activated`, and auto-approve and planning read findings with `status=eq.new` (e.g. `:3765`).
9. The executor task gets only `EXEC_ID` per run (`services/gateway/src/services/aws-ecs-admin.ts:70`); its env comes
   from the task definition, which only `.github/workflows/AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` manages (`:182-236`).
10. Every new operator hand-off is a scenario in `services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts` (CLAUDE.md NEVER 42e/42f).

## 1. Goal
The seven connections of the mission, with GitLab as the source of delivery facts, and the repair of a failed GitLab merge-request
pipeline run by Dev Autopilot's existing executor on the merge request's own branch, never through a GitHub PR. Everything ships off:
`DELIVERY_LOOP_ENABLED` unset starts nothing, and the executor needs `DELIVERY_LOOP_EXECUTOR=dev-autopilot` and its own GitLab token.

## 2. Lanes (all `executor: kiro`, repo `exafyltd/vitana-platform`)
| Lane | What | Depends on |
|---|---|---|
| `durable-events` | `CicdOasisEvent.idempotency_key`; `emitOasisEvent` derives the row id from (env, topic, key) and inserts with `resolution=ignore-duplicates` (a repeat is one row); the stage writes with `dedupe_key`; issue facts `scm.gitlab.issue.opened/labeled/closed` for the intake label; `failed_jobs` on failed pipelines; ALL new event types of this plan in `types/cicd.ts` (the `delivery.*` topics and `dev_autopilot.execution.gitlab_pushed`) | none |
| `loop-engine` | `services/gateway/src/services/delivery-loop/` minus adapters and runtime: the GitLab REST client (project allowlist, the token only in PRIVATE-TOKEN), failure fingerprint, controls (autonomy L0..L3, default L1; act needs L3 and execution armed), facts, ledger, intents, intake, heal (the `delivery.heal.*` writer), drive, review, learn, improve, poll, engine; `TaskRequest.dispatch_key` (one per attempt) and `repair` facts | durable-events |
| `loop-rehearsal` | `scripts/delivery-loop/*`: the guarded rehearsal against the GitLab project `vitana/rehearsal` (one project, named writes, nothing on `main`, cleanup) | loop-engine |
| `gitlab-executor` | the GitLab-native Dev Autopilot execution (section 3) and the bridge guards (section 4) | loop-engine |
| `loop-runtime` | adapters (learn, review, executor port), the scheduler, `GET /api/v1/delivery-loop/status` (requireServiceOrAdmin, read-only), the start in `index.ts` behind `DELIVERY_LOOP_ENABLED=true`, the atlas entry, `.env.example`; binds the `gitlab-executor` gateway | gitlab-executor |

## 3. gitlab-executor
- **Hand-off** `delivery-loop/dev-autopilot-gateway.ts`: the loop's `dev-autopilot` executor. Repairs only; refuses intake, rework,
  `main`, `master`, the target branch and any branch outside `DELIVERY_LOOP_BRANCH_PREFIXES`, all without calling Dev Autopilot.
- **Queue** `dev-autopilot-gitlab-repair.ts`: one carrier finding per merge request (`spec_snapshot.dedupe_key`), status `auto_archived`
  (premise 8: no tick acts on it), scanner `delivery-loop`, `activated_vtid` null; one plan version per attempt, `files_referenced` empty;
  one `cooling` execution per dispatch key, in ONE insert with `metadata.host = 'gitlab'`, `metadata.executor = 'agent'` and the target
  (`project_path, mr_iid, mr_url, source_branch, target_branch, pipeline_id, sha, work_key, dispatch_key`). No `branch`, `pr_url` or
  `pr_number`. Nothing is written for an invalid target, while the kill switch is on or when it cannot be read. A second in-flight repair
  of one merge request is refused by the in-flight index (premise 7) as `executor_busy`.
- **Run**: `runExecutionSession` sends a GitLab row to the agent runner, skipping the GitHub PR-flood guard and the single-shot path. The
  runner clones the source branch from GitLab with the executor token `DEV_AUTOPILOT_GITLAB_TOKEN` (`https://oauth2:<token>@<host>/<project>.git`),
  refuses a branch whose head is not the failing sha, reads the merge base with the target branch (nothing merged), prompts in fix mode
  with the failing job's output, runs the same scope, test-coverage, tsc and jest checks, and pushes ONE commit with
  `--force-with-lease=refs/heads/<branch>:<failing sha>` (accepted only as a fast-forward of the failing head; never `--force`). No PR
  contract, no evidence files in the merge request, no PR, no approval hold. DRY_RUN pushes nothing and reports failure.
- **End**: `applyExecutionResult` → pushed: `auto_archived` + `metadata.gitlab_result` + event `dev_autopilot.execution.gitlab_pushed`;
  anything else: `failed`, never bridged. Both writes are conditional on `running`. GitLab's pipeline judges the push; the loop's heal
  reconciler reads it.

## 4. Bridge guards (`dev-autopilot-bridge.ts`)
- **G1**, right after the row is loaded: a GitLab-hosted row (any `host: 'gitlab'` or `gitlab` block, valid or not) → `unsupported_execution`,
  no triage, no GitHub call, no write.
- **G2**, after the idempotency check: status outside `BRIDGEABLE_STATUSES` = {failed, running, ci, merging, deploying, verifying} (the states
  today's callers leave a failed row in) → `unsupported_state`, before the first write.
- `revertExecutionPR`, `isFixModeEligible` and `spawnChildExecution` each refuse a GitLab row on their own.

## 5. Interfaces between lanes
- `CicdOasisEvent.idempotency_key` and the deterministic row id: durable-events → loop-engine.
- Fact topics and payloads (`scm.gitlab.issue.*`, `failed_jobs`, `mr_source_branch`, `mr_target_branch`, `mr_url`): durable-events → loop-engine.
- `TaskRequest` (`key` = the work, `dispatch_key` = the attempt, `repair` = {pipeline_id, sha, mr_url}), `TaskPort`, `ExecutorGateway`: loop-engine → gitlab-executor → loop-runtime.
- `metadata.host = 'gitlab'` + `metadata.gitlab` (`GitlabTarget`): inside gitlab-executor; the guards key on it.
- Env: `DELIVERY_LOOP_*`, `DELIVERY_INTAKE_LABEL`, `GITLAB_API_URL`, `GITLAB_API_TOKEN` (the loop: read and comment), `DEV_AUTOPILOT_GITLAB_TOKEN` (the executor: write_repository).

## 6. Shared and hot files
No two lanes edit one file. `types/cicd.ts` belongs to durable-events only; `services/gateway/src/index.ts`, `.env.example` and
`domain-atlas.ts` to loop-runtime only; the operator suite and its harness to gitlab-executor only. The order is the `depends_on` chain.

## 7. Tests (each new test recorded red on the base before the code)
Per lane, the lane's suites (the WIP branch has them: `test/delivery/*`, `test/oasis-event-idempotency.test.ts`, `test/delivery-loop/*`,
`test/dev-autopilot-bridge-gitlab-guards.test.ts`, `test/dev-autopilot-gitlab-repair.test.ts`, `test/autopilot-agent-gitlab-target.test.ts`,
`test/autopilot-agent-workspace-gitlab.test.ts`, 4 scenarios in the operator suite), then the operator (75), role-separation and
customer-support suites, the locked source-type list, `tsc --noEmit`, and the full gateway suite (only the 2 known failures:
storage-provider, vtid-04226).

## 8. Staging proof
Every lane ships off, so its staging suite asserts the off state, read-only: `GET /api/v1/delivery-loop/status` with the service token
→ 200 JSON `{running:false}` and 401 without it; the GitLab webhook route still answers 401 to an unsigned request. Nothing on staging
writes a GitLab object or a database row.

## 9. Risks
- A GitLab row reaching a GitHub path: G1, the per-helper refusals and the absence of PR fields; the operator suite asserts zero GitHub calls.
- A repair overwriting a person's push: the head check at clone and the lease at push.
- Duplicate executions: one per dispatch key (enqueue) and one in flight per merge request (index).
- Ledger side effects: the carrier finding has no VTID and the end status maps to no ledger status.

## 10. Unchanged
The locked source-type list, `dev-autopilot-watcher.ts`, every migration, every workflow and task definition, production. The loop
merges nothing.
<!-- plan:end -->

## Owner steps (not lanes)
Fixing PLAN-SPAR's authentication or naming another sparring path (`registration-blocked.md`); the executor's GitLab token on the
executor task definition (production workflow); GitLab project webhooks and their signing secret; switching the loop on and raising
its autonomy (CLAUDE.md NEVER 34, stop 13).
