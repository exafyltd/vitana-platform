# Self-Healing Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current speculative self-healing loop with a closed-loop repair system that can detect, diagnose, patch, verify, deploy, rollback, and learn without falsely marking unresolved incidents as fixed.

**Architecture:** The system should treat "100% self-healing" as "all safe, known classes are repaired automatically; unsafe, ambiguous, or repeatedly failing classes are escalated with complete evidence." Self-healing becomes a state-machine-backed pipeline: incident intake -> diagnosis -> spec -> real patch artifact -> test/verification -> PR/deploy/canary -> production verification -> rollback or terminal success. Every terminal state must be backed by evidence, not by an LLM success claim.

**Tech Stack:** TypeScript/Node gateway and worker-runner, Supabase/Postgres, OASIS events, Git/GitHub Actions, Cloud Run, Playwright/Jest, existing Command Hub frontend.

---

## Current Failure Summary

The codebase already contains most of the parts of a self-healing system, but the parts do not form a trustworthy repair loop.

1. The worker execution prompt tells the LLM: `DO NOT actually modify files - describe what changes would be made.` See `services/worker-runner/src/services/execution-service.ts`.
2. The worker then reports success from JSON and terminalizes the VTID even though no patch, branch, commit, PR, deployment, or production change is guaranteed.
3. The worker always sends `skip_verification: true`, while the gateway usually rejects that bypass. The runner does not treat that rejection as fatal before terminalization.
4. The pending-task API does not hydrate `spec_content`, so self-healing workers can execute with "No specification provided."
5. OASIS event replay is timestamp-only and can skip same-timestamp events or discard unprocessed events when execution is disarmed.
6. E2E failure reports use `/api/v1/e2e/health`, but self-healing rejects endpoints that are not in `ENDPOINT_FILE_MAP`, so important failures are skipped at intake.
7. Rollback records events but does not actually shift Cloud Run traffic or dispatch the rollback workflow required by the original spec.
8. Snapshot verification has no git SHA or Cloud Run revision, so it cannot prove what code was fixed or rolled back.
9. The Command Hub canonical URL moved to `/command-hub/autonomy/self-healing/`, but backend notifications still default to `/command-hub/infrastructure/self-healing`.
10. There are only peripheral tests for autonomy/voice self-healing, not a complete end-to-end contract test for detect -> patch -> verify -> terminalize.

---

## File Structure

Modify:
- `services/gateway/src/routes/self-healing.ts` - report intake, URL defaults, approval semantics, verification endpoints.
- `services/gateway/src/services/self-healing-diagnosis-service.ts` - richer diagnosis inputs and repo/runtime evidence.
- `services/gateway/src/services/self-healing-spec-service.ts` - spec acceptance criteria and executable repair metadata.
- `services/gateway/src/services/self-healing-injector-service.ts` - injected task metadata, target paths, spec linkage.
- `services/gateway/src/services/self-healing-reconciler.ts` - outcome semantics, redispatch rules, stale state handling.
- `services/gateway/src/services/self-healing-snapshot-service.ts` - git SHA, Cloud Run revision, canary/rollback execution.
- `services/gateway/src/services/autopilot-event-loop.ts` - durable cursor and replay rules.
- `services/gateway/src/services/autopilot-event-mapper.ts` - terminal-state mapping backed by verified evidence.
- `services/gateway/src/routes/worker-orchestrator.ts` - pending-task hydration and completion-gate behavior.
- `services/worker-runner/src/services/execution-service.ts` - replace dry-run description with real patch generation/application.
- `services/worker-runner/src/services/gateway-client.ts` - remove unconditional verification bypass and return fatal completion errors.
- `services/worker-runner/src/services/runner-service.ts` - terminalize only after accepted verification.
- `services/worker-runner/src/types.ts` - add patch, artifact, verification, and spec-required types.
- `services/gateway/src/frontend/command-hub/app.js` - show truthful pipeline states and canonical self-healing route.
- `services/gateway/specs/dev-screen-inventory-v1.json` - keep screen inventory aligned with canonical route.
- `.github/workflows/E2E-TEST-RUN.yml` - report E2E failures as accepted incident classes.
- `.github/workflows/E2E-ORB-MONITOR.yml` - include run evidence and artifact links.
- `.github/workflows/SELF-HEALING-ROLLBACK.yml` - add or wire rollback workflow dispatch.
- `scripts/ci/collect-status.py` - include canonical incident type and evidence fields.

Create:
- `services/gateway/src/services/self-healing-incident-normalizer.ts` - converts endpoint/test/workflow failures into canonical incident signatures.
- `services/gateway/src/services/self-healing-state-machine.ts` - allowed transitions and evidence requirements.
- `services/gateway/src/services/self-healing-repair-evidence.ts` - common evidence writer/reader for specs, patches, tests, deploys, verification.
- `services/worker-runner/src/services/patch-workspace-service.ts` - isolated worktree setup, patch apply, git diff, cleanup.
- `services/worker-runner/src/services/patch-contract.ts` - JSON schema for LLM patch plans and execution artifacts.
- `services/gateway/test/self-healing-report-intake.test.ts` - intake normalization and skip behavior.
- `services/gateway/test/self-healing-event-cursor.test.ts` - cursor replay and disarmed behavior.
- `services/gateway/test/self-healing-pending-task-hydration.test.ts` - spec hydration contract.
- `services/gateway/test/self-healing-verification-state-machine.test.ts` - terminal-state evidence rules.
- `services/worker-runner/test/patch-workspace-service.test.ts` - real patch application behavior.
- `services/worker-runner/test/runner-completion-gates.test.ts` - no false terminal success.
- `docs/specs/SELF-HEALING-RUNTIME-CONTRACT.md` - production contract and safety boundaries.

---

## Task 1: Establish Failing Contract Tests

**Files:**
- Create: `services/gateway/test/self-healing-report-intake.test.ts`
- Create: `services/gateway/test/self-healing-pending-task-hydration.test.ts`
- Create: `services/worker-runner/test/runner-completion-gates.test.ts`
- Modify: package test config only if the new worker-runner test folder is not already included.

- [ ] **Step 1: Write intake tests for accepted E2E incidents**

Add tests that POST a health report containing endpoint `/api/v1/e2e/health` and assert the route does not return `reason: "Unknown endpoint - not in gateway route map"`. The expected normalized incident should have:

```ts
{
  kind: 'workflow_failure',
  source: 'github_actions',
  endpoint: '/api/v1/e2e/health',
  failure_class: 'e2e_regression',
}
```

- [ ] **Step 2: Write pending-task hydration tests**

Mock Supabase responses for `vtid_ledger` and `vtid_specs`. Assert `GET /api/v1/worker/orchestrator/tasks/pending` returns `spec_content`, `metadata`, `task_domain`, and `target_paths` for a self-healing VTID.

- [ ] **Step 3: Write completion-gate tests**

Mock `reportSubagentComplete` and `reportOrchestratorComplete` returning HTTP 403 for `skip_verification`. Assert `runner-service` marks the task failed and does not call `terminalizeTask(..., 'success', ...)`.

- [ ] **Step 4: Run tests and confirm the current failures**

Run:

```bash
npm test -- --runInBand self-healing-report-intake self-healing-pending-task-hydration runner-completion-gates
```

Expected: tests fail for unknown endpoint skipping, missing spec hydration, and false terminal success.

- [ ] **Step 5: Commit tests**

Run:

```bash
git add services/gateway/test services/worker-runner/test
git commit -m "test: capture self-healing reliability gaps"
```

---

## Task 2: Normalize Incidents Instead Of Dropping Them

**Files:**
- Create: `services/gateway/src/services/self-healing-incident-normalizer.ts`
- Modify: `services/gateway/src/routes/self-healing.ts`
- Modify: `.github/workflows/E2E-TEST-RUN.yml`
- Modify: `.github/workflows/E2E-ORB-MONITOR.yml`
- Modify: `scripts/ci/collect-status.py`
- Test: `services/gateway/test/self-healing-report-intake.test.ts`

- [ ] **Step 1: Implement canonical incident normalization**

`normalizeSelfHealingIncident(reportService)` should return:

```ts
type SelfHealingIncidentKind =
  | 'endpoint_health'
  | 'workflow_failure'
  | 'voice_synthetic'
  | 'routine_incident';

interface SelfHealingIncident {
  accepted: boolean;
  kind: SelfHealingIncidentKind;
  endpoint: string;
  service_name: string;
  failure_class_hint: string;
  evidence: Record<string, unknown>;
  skip_reason?: string;
}
```

Rules:
- Known `ENDPOINT_FILE_MAP` endpoints become `endpoint_health`.
- `voice-error://...` becomes `voice_synthetic`.
- `routine-incident://...` becomes `routine_incident`.
- `/api/v1/e2e/health` becomes `workflow_failure`, not skipped.
- Unknown HTTP endpoints are skipped unless the report contains `source: 'github_actions'` or `workflow_url`.

- [ ] **Step 2: Replace inline allowlist logic**

In `routes/self-healing.ts`, replace the local `knownEndpoints` loop with `normalizeSelfHealingIncident`. Preserve the existing skip response shape, but make skips evidence-backed and machine-readable.

- [ ] **Step 3: Enrich CI reports**

Update E2E workflows and `collect-status.py` to send:

```json
{
  "source": "github_actions",
  "workflow": "E2E-TEST-RUN",
  "run_id": "${{ github.run_id }}",
  "run_url": "https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}"
}
```

- [ ] **Step 4: Run intake tests**

Run:

```bash
npm test -- --runInBand self-healing-report-intake
```

Expected: `/api/v1/e2e/health` creates or dedupes an incident instead of being skipped.

- [ ] **Step 5: Commit**

Run:

```bash
git add services/gateway/src/services/self-healing-incident-normalizer.ts services/gateway/src/routes/self-healing.ts .github/workflows/E2E-TEST-RUN.yml .github/workflows/E2E-ORB-MONITOR.yml scripts/ci/collect-status.py services/gateway/test/self-healing-report-intake.test.ts
git commit -m "fix: normalize self-healing incident intake"
```

---

## Task 3: Make OASIS Event Consumption Durable

**Files:**
- Modify: `services/gateway/src/services/autopilot-event-loop.ts`
- Create: `services/gateway/test/self-healing-event-cursor.test.ts`
- Optional migration: add a processed-event table if tuple cursor storage is not enough.

- [ ] **Step 1: Write cursor replay tests**

Cover these cases:
- Two events have the same `created_at`; both are processed in `id.asc` order.
- Execution is disarmed; actionable events are not marked consumed.
- A stale cursor does not jump to "one minute ago" without storing skipped events as intentionally abandoned.

- [ ] **Step 2: Replace timestamp-only cursor**

Use a cursor with both timestamp and id:

```ts
interface OasisCursor {
  created_at: string;
  id: string;
}
```

Fetch with:
- `created_at > cursor.created_at`, or
- `created_at = cursor.created_at AND id > cursor.id`.

If Supabase REST cannot express this cleanly, add an RPC `fetch_oasis_events_after_cursor(p_created_at timestamptz, p_id uuid, p_limit int)`.

- [ ] **Step 3: Do not advance the cursor while disarmed**

When execution is disarmed, record an `execution_blocked` event or backlog metric, but leave the cursor before the unprocessed actionable event.

- [ ] **Step 4: Add replay command**

Add an admin-safe method to replay self-healing events by VTID or time range without duplicating terminal state transitions.

- [ ] **Step 5: Run tests**

Run:

```bash
npm test -- --runInBand self-healing-event-cursor
```

Expected: all cursor replay scenarios pass.

- [ ] **Step 6: Commit**

Run:

```bash
git add services/gateway/src/services/autopilot-event-loop.ts services/gateway/test/self-healing-event-cursor.test.ts supabase/migrations
git commit -m "fix: make autopilot event cursor durable"
```

---

## Task 4: Hydrate Specs And Require Them For Self-Healing Execution

**Files:**
- Modify: `services/gateway/src/routes/worker-orchestrator.ts`
- Modify: `services/worker-runner/src/types.ts`
- Modify: `services/worker-runner/src/services/runner-service.ts`
- Test: `services/gateway/test/self-healing-pending-task-hydration.test.ts`

- [ ] **Step 1: Return executable spec content from pending tasks**

Extend the pending-task route to include:

```ts
{
  spec_content: string;
  metadata: Record<string, unknown>;
  task_domain: 'frontend' | 'backend' | 'infra' | 'ai' | 'memory';
  target_paths: string[];
  spec_hash: string;
}
```

Read `vtid_specs` by VTID and prefer its canonical markdown/content over `vtid_ledger.summary`.

- [ ] **Step 2: Fail closed when self-healing has no spec**

In `runner-service.ts`, before routing a task:

```ts
const isSelfHealing = task.metadata?.source === 'self-healing';
if (isSelfHealing && !task.spec_content?.trim()) {
  throw new Error(`Self-healing task ${task.vtid} has no hydrated spec_content`);
}
```

- [ ] **Step 3: Pass target paths into governance**

Ensure `routeTask` receives `target_paths` and uses them in `runPreflightChain`.

- [ ] **Step 4: Run hydration tests**

Run:

```bash
npm test -- --runInBand self-healing-pending-task-hydration
```

Expected: self-healing tasks include spec content and fail closed when it is missing.

- [ ] **Step 5: Commit**

Run:

```bash
git add services/gateway/src/routes/worker-orchestrator.ts services/worker-runner/src/types.ts services/worker-runner/src/services/runner-service.ts services/gateway/test/self-healing-pending-task-hydration.test.ts
git commit -m "fix: hydrate self-healing specs for workers"
```

---

## Task 5: Replace Dry-Run LLM Output With Real Patch Artifacts

**Files:**
- Create: `services/worker-runner/src/services/patch-contract.ts`
- Create: `services/worker-runner/src/services/patch-workspace-service.ts`
- Modify: `services/worker-runner/src/services/execution-service.ts`
- Modify: `services/worker-runner/src/types.ts`
- Create: `services/worker-runner/test/patch-workspace-service.test.ts`

- [ ] **Step 1: Define the patch contract**

The LLM response must validate to this shape before any terminal success:

```ts
interface PatchPlan {
  ok: boolean;
  summary: string;
  unified_diff: string;
  files_changed: string[];
  files_created: string[];
  tests_to_run: string[];
  risk_level: 'low' | 'medium' | 'high';
  rollback_plan: string[];
  error?: string;
}
```

- [ ] **Step 2: Remove the dry-run instruction**

Replace `DO NOT actually modify files - describe what changes would be made` with instructions to produce a minimal unified diff constrained to `target_paths` and the spec.

- [ ] **Step 3: Apply patches in an isolated workspace**

`patch-workspace-service.ts` should:
- create a clean worktree for the VTID,
- apply the unified diff with `git apply --check`,
- apply the patch,
- run `git diff --name-only`,
- reject changes outside `target_paths`,
- return patch evidence containing diff hash and changed files.

- [ ] **Step 4: Run the declared tests**

For self-healing tasks, run the tests declared by the patch contract plus a service-specific minimum:
- gateway route/service changes: `npm test -- --runInBand <relevant-tests>`
- TypeScript changes: `npm run typecheck` if available for that package
- frontend Command Hub changes: existing frontend smoke tests or Playwright smoke where available

- [ ] **Step 5: Persist artifacts**

Persist:
- patch diff,
- changed files,
- test commands,
- test outputs,
- worktree branch,
- commit SHA if committed,
- PR URL if opened.

Use `self-healing-repair-evidence.ts` from Task 9 if that task has already landed; otherwise store evidence in VTID metadata and OASIS event payloads.

- [ ] **Step 6: Run patch tests**

Run:

```bash
npm test -- --runInBand patch-workspace-service
```

Expected: valid diffs apply, invalid diffs fail, out-of-scope paths fail.

- [ ] **Step 7: Commit**

Run:

```bash
git add services/worker-runner/src/services/patch-contract.ts services/worker-runner/src/services/patch-workspace-service.ts services/worker-runner/src/services/execution-service.ts services/worker-runner/src/types.ts services/worker-runner/test/patch-workspace-service.test.ts
git commit -m "feat: execute self-healing patches in isolated workspaces"
```

---

## Task 6: Stop False Terminal Success

**Files:**
- Modify: `services/worker-runner/src/services/gateway-client.ts`
- Modify: `services/worker-runner/src/services/runner-service.ts`
- Modify: `services/gateway/src/routes/worker-orchestrator.ts`
- Create or modify: `services/worker-runner/test/runner-completion-gates.test.ts`
- Create: `services/gateway/test/self-healing-verification-state-machine.test.ts`

- [ ] **Step 1: Remove unconditional `skip_verification: true`**

`gateway-client.ts` must send `skip_verification` only when explicitly configured for test/CI and accompanied by a valid governance override.

- [ ] **Step 2: Make gateway completion failures fatal**

Change `reportSubagentComplete` and `reportOrchestratorComplete` to return typed results and throw on non-2xx responses.

- [ ] **Step 3: Terminalize only after accepted completion**

In `runner-service.ts`, terminal success requires:
- patch artifact exists,
- changed files match the patch contract,
- declared tests passed,
- gateway accepted subagent completion,
- gateway accepted orchestrator completion,
- self-healing verification accepted or has moved to deployment/canary stage.

- [ ] **Step 4: Add gateway guardrails**

In `worker-orchestrator.ts`, reject successful self-healing completion if:
- `files_changed` and `files_created` are both empty,
- no patch artifact or commit SHA is present,
- no test evidence is present,
- `skip_verification` is requested without approval.

- [ ] **Step 5: Run completion tests**

Run:

```bash
npm test -- --runInBand runner-completion-gates self-healing-verification-state-machine
```

Expected: no self-healing VTID reaches terminal success without evidence.

- [ ] **Step 6: Commit**

Run:

```bash
git add services/worker-runner/src/services/gateway-client.ts services/worker-runner/src/services/runner-service.ts services/gateway/src/routes/worker-orchestrator.ts services/worker-runner/test/runner-completion-gates.test.ts services/gateway/test/self-healing-verification-state-machine.test.ts
git commit -m "fix: require evidence before self-healing terminal success"
```

---

## Task 7: Add Real Deployment, Canary Verification, And Rollback

**Files:**
- Modify: `services/gateway/src/services/self-healing-snapshot-service.ts`
- Modify: `services/gateway/src/services/autopilot-event-loop.ts`
- Create: `.github/workflows/SELF-HEALING-ROLLBACK.yml`
- Modify: docs/specs if the runtime contract changes.
- Test: `services/gateway/test/self-healing-verification-state-machine.test.ts`

- [ ] **Step 1: Capture deploy identity**

Snapshots must include:

```ts
{
  git_sha: string;
  cloud_run_revision: string;
  traffic_percent: number;
  deployment_url: string;
}
```

Read these from environment, Cloud Run metadata, or a deploy-manifest table written by deployment workflows.

- [ ] **Step 2: Verify the target endpoint by current state, not only transition delta**

Target fixed should mean the target endpoint is healthy in the post-fix snapshot. Keep `newlyFixed` for diagnostics, but do not require a down->up transition if the pre snapshot was late.

- [ ] **Step 3: Gate rollout**

For code fixes:
- deploy to a new revision,
- route 10% traffic,
- run target health and blast-radius checks,
- route 100% traffic only after canary passes,
- record every traffic shift as OASIS events.

- [ ] **Step 4: Dispatch actual rollback**

`executeRollback` must call the rollback workflow or Cloud Run traffic API. It must not emit `rollback.completed` until traffic has actually shifted and post-rollback health is verified.

- [ ] **Step 5: Run verification tests**

Run:

```bash
npm test -- --runInBand self-healing-verification-state-machine
```

Expected: rollback remains `requested` until actual rollback evidence exists; successful fix requires healthy target plus no blast radius.

- [ ] **Step 6: Commit**

Run:

```bash
git add services/gateway/src/services/self-healing-snapshot-service.ts services/gateway/src/services/autopilot-event-loop.ts .github/workflows/SELF-HEALING-ROLLBACK.yml services/gateway/test/self-healing-verification-state-machine.test.ts
git commit -m "feat: add evidence-backed self-healing rollout and rollback"
```

---

## Task 8: Improve Diagnosis With Repo And Runtime Context

**Files:**
- Modify: `services/gateway/src/services/self-healing-diagnosis-service.ts`
- Modify: `services/gateway/src/services/self-healing-triage-service.ts`
- Modify: `services/gateway/src/services/self-healing-spec-service.ts`
- Modify: `services/gateway/src/services/self-healing-injector-service.ts`
- Add tests near existing gateway service tests.

- [ ] **Step 1: Restore code-aware triage for hard failures**

When confidence is below auto-fix threshold, triage must receive:
- route file path,
- target paths,
- last deploy SHA,
- relevant logs,
- workflow run URL,
- recent self-healing attempts for same signature,
- current spec and previous failed spec hashes.

- [ ] **Step 2: Replace manual VTID increments**

`createFreshVtidFromTriageReport` must use the existing VTID allocation RPC or a sequence-backed insert. It must not select the latest row and add one.

- [ ] **Step 3: Generate executable metadata**

Specs must include:
- target paths,
- test commands,
- rollback commands,
- expected health assertions,
- disallowed changes,
- risk level,
- auto-merge eligibility.

- [ ] **Step 4: Remove nonexistent acceptance signals**

Replace `self-healing.fix.applied` acceptance criteria unless Task 5 emits that event after a patch is actually applied. The acceptance signal should be tied to real patch evidence.

- [ ] **Step 5: Run diagnosis/spec tests**

Run:

```bash
npm test -- --runInBand self-healing
```

Expected: diagnosis produces target paths and executable metadata; low-confidence triage includes code/runtime evidence.

- [ ] **Step 6: Commit**

Run:

```bash
git add services/gateway/src/services/self-healing-diagnosis-service.ts services/gateway/src/services/self-healing-triage-service.ts services/gateway/src/services/self-healing-spec-service.ts services/gateway/src/services/self-healing-injector-service.ts services/gateway/test
git commit -m "feat: enrich self-healing diagnosis and specs"
```

---

## Task 9: Fix Outcome Semantics And Command Hub Truthfulness

**Files:**
- Create: `services/gateway/src/services/self-healing-state-machine.ts`
- Modify: `services/gateway/src/services/self-healing-reconciler.ts`
- Modify: `services/gateway/src/routes/self-healing.ts`
- Modify: `services/gateway/src/frontend/command-hub/app.js`
- Modify: `services/gateway/specs/dev-screen-inventory-v1.json`
- Modify: `docs/specs/SELF-HEALING-TEST-PLAN.md`

- [ ] **Step 1: Define terminal outcomes**

Use explicit outcomes:
- `fixed` - production verified after repair.
- `recovered_externally` - endpoint healthy, no repair evidence.
- `rolled_back` - rollback executed and verified.
- `failed` - attempted repair failed with evidence.
- `escalated` - human action required.
- `skipped` - intentionally not acted on.
- `paused` - kill switch or governance hold.

- [ ] **Step 2: Stop marking success-ish reconciler states as escalated**

`probe_verified` and `recovered_externally` should not write `outcome: 'escalated'`. They should use the explicit outcome above and preserve the reason in `diagnosis.reconciled_reason`.

- [ ] **Step 3: Align canonical URL**

Set `COMMAND_HUB_SH_URL` defaults to:

```text
https://gateway-q74ibpv6ia-uc.a.run.app/command-hub/autonomy/self-healing/
```

Keep frontend redirects for old infrastructure links.

- [ ] **Step 4: Make the UI show evidence, not only status**

Command Hub should show:
- incident source,
- current stage,
- blocking reason,
- patch artifact or "no patch yet",
- test status,
- deploy revision,
- verification snapshot IDs,
- rollback state.

- [ ] **Step 5: Run frontend and gateway tests**

Run:

```bash
npm test -- --runInBand autonomy-pulse autonomy-trace self-healing
```

Expected: history rows distinguish fixed, external recovery, rollback, failed, and escalated.

- [ ] **Step 6: Commit**

Run:

```bash
git add services/gateway/src/services/self-healing-state-machine.ts services/gateway/src/services/self-healing-reconciler.ts services/gateway/src/routes/self-healing.ts services/gateway/src/frontend/command-hub/app.js services/gateway/specs/dev-screen-inventory-v1.json docs/specs/SELF-HEALING-TEST-PLAN.md
git commit -m "fix: show truthful self-healing outcomes"
```

---

## Task 10: Add Repair Memory And Anti-Loop Controls

**Files:**
- Create: `services/gateway/src/services/self-healing-repair-evidence.ts`
- Add migration for `self_healing_repair_attempts` or extend existing tables with evidence columns.
- Modify: `services/gateway/src/services/self-healing-reconciler.ts`
- Modify: `services/gateway/src/services/self-healing-spec-service.ts`
- Modify: `services/gateway/src/routes/self-healing.ts`

- [ ] **Step 1: Store every repair attempt**

Persist:

```ts
interface SelfHealingRepairAttempt {
  vtid: string;
  incident_signature: string;
  spec_hash: string;
  patch_hash?: string;
  changed_files: string[];
  test_commands: string[];
  test_passed: boolean;
  deploy_revision?: string;
  verification_outcome: string;
  failure_reason?: string;
}
```

- [ ] **Step 2: Block repeated failed fixes**

Before generating or dispatching a spec, check recent attempts with the same `incident_signature` and `spec_hash`. If the same fix failed twice in 72 hours, require human approval and include the previous evidence.

- [ ] **Step 3: Rank known-good fixes higher**

If a spec hash fixed the same signature previously and no regression happened, allow auto-fix at a higher confidence within the same risk class.

- [ ] **Step 4: Add recurring failure alerts**

If the same endpoint/signature fails after a verified fix, escalate as recurrence instead of creating another generic repair.

- [ ] **Step 5: Run repair-memory tests**

Run:

```bash
npm test -- --runInBand self-healing-repair-memory self-healing
```

Expected: repeated bad fixes are blocked; known-good fixes are reused only within guardrails.

- [ ] **Step 6: Commit**

Run:

```bash
git add services/gateway/src/services/self-healing-repair-evidence.ts services/gateway/src/services/self-healing-reconciler.ts services/gateway/src/services/self-healing-spec-service.ts services/gateway/src/routes/self-healing.ts supabase/migrations services/gateway/test
git commit -m "feat: add self-healing repair memory"
```

---

## Task 11: End-To-End Chaos Harness

**Files:**
- Create: `services/gateway/test/self-healing-e2e-harness.test.ts`
- Create: `services/worker-runner/test/self-healing-worker-e2e.test.ts`
- Modify: CI workflow to run these tests before self-healing auto-mode can be enabled.
- Modify: `docs/specs/SELF-HEALING-RUNTIME-CONTRACT.md`

- [ ] **Step 1: Build a fake incident flow**

The harness should simulate:
- a failing endpoint report,
- diagnosis,
- spec generation,
- injection,
- worker pickup,
- patch artifact,
- test pass,
- deploy/canary event,
- post-fix health success,
- terminal success.

- [ ] **Step 2: Build negative flows**

Cover:
- unknown endpoint with no evidence -> skipped,
- E2E failure with evidence -> accepted,
- missing spec -> fail closed,
- LLM says ok with no diff -> rejected,
- gateway rejects completion -> no terminal success,
- blast radius -> rollback requested and then verified,
- rollback workflow fails -> escalated.

- [ ] **Step 3: Add CI gate**

Self-healing autonomous mode cannot be set above `diagnose_only` unless the chaos harness passes on the target branch.

- [ ] **Step 4: Run harness**

Run:

```bash
npm test -- --runInBand self-healing-e2e-harness self-healing-worker-e2e
```

Expected: happy path passes and every negative case avoids false success.

- [ ] **Step 5: Commit**

Run:

```bash
git add services/gateway/test/self-healing-e2e-harness.test.ts services/worker-runner/test/self-healing-worker-e2e.test.ts .github/workflows docs/specs/SELF-HEALING-RUNTIME-CONTRACT.md
git commit -m "test: add self-healing end-to-end chaos harness"
```

---

## Task 12: Operational Rollout

**Files:**
- Modify: `docs/specs/SELF-HEALING-RUNTIME-CONTRACT.md`
- Modify: deployment/config docs for `self_healing_autonomy_level`.
- Modify: Command Hub config copy if needed.

- [ ] **Step 1: Define autonomy levels**

Use these levels:
- `observe_only` - log and display only.
- `diagnose_only` - produce diagnosis and spec, no execution.
- `patch_pr_only` - create patch PRs, no auto-merge.
- `auto_fix_low_risk` - auto-merge/deploy only low-risk known classes with rollback ready.
- `auto_fix_canary` - low-risk auto-deploy through 10% canary.
- `full_auto_bounded` - all eligible known classes auto-repair; unknown and high-risk classes escalate.

- [ ] **Step 2: Stage rollout**

Roll out in this order:
1. `diagnose_only` for 48 hours with no skipped accepted incident classes.
2. `patch_pr_only` until 10 consecutive correct patch PRs.
3. `auto_fix_low_risk` for route-map/config/env-var failures.
4. `auto_fix_canary` once rollback workflow is proven.
5. `full_auto_bounded` only after the chaos harness is required in CI.

- [ ] **Step 3: Define success metrics**

Track:
- incident acceptance rate,
- false skip rate,
- diagnosis accuracy,
- patch apply success,
- test pass rate,
- verified production fix rate,
- rollback rate,
- false terminal success count,
- recurrence within 72 hours.

The false terminal success count must stay at zero.

- [ ] **Step 4: Commit docs**

Run:

```bash
git add docs/specs/SELF-HEALING-RUNTIME-CONTRACT.md docs/specs/SELF-HEALING-TEST-PLAN.md
git commit -m "docs: define self-healing rollout contract"
```

---

## Verification Before Enabling Full Auto Mode

Run:

```bash
npm test -- --runInBand self-healing-report-intake self-healing-pending-task-hydration self-healing-event-cursor self-healing-verification-state-machine runner-completion-gates patch-workspace-service self-healing-e2e-harness self-healing-worker-e2e
```

Expected:
- no accepted incident is silently skipped,
- no self-healing task executes without spec content,
- no LLM-only success can terminalize a VTID,
- every fixed outcome has patch/test/deploy/verification evidence,
- rollback is real and verified,
- Command Hub shows accurate outcome semantics.

Only after this command passes should `self_healing_autonomy_level` be allowed above `patch_pr_only`.

---

## Self-Review

Spec coverage:
- Intake, diagnosis, spec, injection, execution, verification, rollback, UI, repair memory, and rollout are all covered by tasks.
- The plan explicitly handles the observed failures: dry-run worker, skipped E2E endpoint, missing spec hydration, event cursor loss, verification bypass, fake rollback completion, outcome confusion, and stale Command Hub links.

Placeholder scan:
- No task relies on "implement later" or unspecified behavior. Each task names files, exact expected behavior, and verification commands.

Type consistency:
- `spec_content`, `target_paths`, `metadata.source`, patch artifacts, and terminal evidence are used consistently across gateway and worker-runner tasks.
