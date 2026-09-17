# Command Hub Operator Console — what is missing to make it work like Claude Code

**VTID-04002 · 2026-09-17 · deep analysis + the two on-ramp fixes from Test Run #1**

Scope of the question: *what does the Operator Console lack to execute development
tasks on vitanaland / MAXINA the way a Claude Code session does — aware at every
session of the codebase, GitHub, AWS (admin), cross-session memory, RepoWise /
Graphify indexes, the real-time status of the platform, and able to execute fast
with the highest code quality?*

Everything below is grounded in the code on `main` (`a41ff27`), the live
Supabase tables (read-only queries), the live gateway build-info endpoints, and
the real GitHub state of PR #3351. Four parallel code-reading passes covered the
chat→execution chain, the execution plane, memory/context, and credentials.

> **Index caveat.** CLAUDE.md mandates RepoWise + Graphify before any change.
> Neither binary exists in this session and neither repo has a `graphify-out/`
> or `.repowise/` directory — the same is true for the deployed gateway (see §4.5).
> This analysis used targeted source reads instead. That gap is itself finding #5.

---

## 0. Verdict in one paragraph

The Operator Console is a **chat front-end over a single-shot, zero-tool code
generator**, not an agent. One LLM call receives a plan plus the full text of at
most 8 files and must emit complete replacement files in one response; nothing
in the plane can read another file, search, run `tsc`, run a test, observe an
error, or try again. Its "memory" is 28 rows written by five tool names, its
"codebase awareness" is a 1.5 KB hand-typed constant, and its transcript lives in
the operator's browser `localStorage`. On **production** every operator
capability flag except the on-ramp is unset, so the prod console cannot read
code, the DB, or ECS at all. Test Run #1 proved the *model* is not the problem
(the DeepSeek fix in PR #3351 was correct and well tested); the *harness* is.
The PR was killed by a repo governance contract (`VALIDATOR-CHECK.yml`) that the
executor never knew existed, and the self-healing triage then invented a wrong
root cause because it is fed a label, not evidence. The single highest-leverage
move is to replace the single-shot executor with an agentic runner on a real
checkout — the orphaned `services/autopilot-worker` already shells out to the
Claude Code CLI and is the natural seed — and to give the chat layer a
server-side session with a real bootstrap pack (§5, §6).

---

## 1. What exists today — the chain, hop by hop

| # | Hop | Where | What it does |
|---|-----|-------|--------------|
| 0 | HTTP entry | `routes/operator.ts:210` `POST /api/v1/operator/chat` (`optionalAuth`) | Mints a `threadId` per request (the Command Hub never sends one), records the exafy_admin marker for this request, forwards `context` = last 20 messages / 12 000 chars the browser re-uploads every turn |
| 1 | LLM turn | `gemini-operator.ts:3549` `callVertexWithTools` → `callViaRouter('operator')` | System prompt = persona + hand-written list of **6** tools (41 are actually declared) + top-5 `dev_agent_memory` recall + `CODEBASE_OVERVIEW_BLOCK` (6 bullets). Policy v17: `deepseek/deepseek-flash` primary, `bedrock/claude-sonnet-4-6` fallback |
| 2 | Tool dispatch | `gemini-operator.ts:3001` → `executeExecuteTask` | exafy_admin check → governance `A2` → `triggerOperatorExecution` |
| 3 | On-ramp | `operator-execution-onramp.ts` | Kill switch, `spec_status='approved'` + non-terminal gate, inserts `autopilot_recommendations` + `dev_autopilot_plan_versions`, calls `approveAutoExecute` (full safety gate), stamps `llm_on_ramp_override={deepseek,deepseek-flash}`, links execution to `vtid_ledger.metadata` |
| 4 | Safety gate | `dev-autopilot-safety.ts:236` | kill switch, risk class, **allow/deny globs anchored at repo root**, `tests_missing`, daily budget (500), auto-fix depth (2). Live `allow_scope` = gateway `src/{routes,services,types,lib,orb,frontend/command-hub}/**`, `test(s)/**`, `services/agents/**`, `services/worker-runner/**`; deny = migrations, `**/auth*`, workflows, `lib/supabase.ts`, env/credentials |
| 5 | Pick-up | `dev-autopilot-execute.ts:2405` `backgroundExecutorTick` | Claims `cooling→running`; on staging dispatches `ecs:RunTask` of `vitana-autopilot-executor` (same gateway image, `Dockerfile.job` → `job-entry.ts`); on prod `DEV_AUTOPILOT_USE_JOB` is unset so it runs **in-process inside the gateway container** (the 20-minute watchdog / "container recycled mid-execution" failures on 09-13 are this) |
| 6 | Execution | `dev-autopilot-execute.ts:1433` `runExecutionSession` | Fetch ≤8 files from `main` via Contents API → one prompt (conventions constant + LOCKED FILE LIST + plan + full file bodies) → **one** `callViaRouter('worker')` call (32k output tokens) → regex-parse `<<<PR_TITLE>>>/<<<PR_BODY>>>/<<<FILE>>>` blocks → out-of-scope / coverage ≥0.6 / truncation / empty-diff guards → create branch `dev-autopilot/<exec8>` → PUT each file → open PR |
| 7 | After the PR | `dev-autopilot-watcher.ts` (60 s poll), `self-healing-reconciler.ts`, `self-healing-triage-service.ts` | CI failure → `bridgeFailure` → 1-call triage with **no repo and no check logs** → child execution re-runs the **identical prompt** (depth ≤2). Auto-merge (squash, low/medium risk) only when `DEV_AUTOPILOT_WATCHER_LIVE=true` — staging only |

Live numbers (Supabase, 2026-09-17): 7 executions in 30 days, **0 merged, 6 failed/reverted**;
2 operator on-ramp executions ever (one `completed` on 09-14, PR #3307; one reverted on 09-16, PR #3351).
`dev_agent_memory`: 28 rows, all `task_outcome`, 26 of them a one-time backfill.

---

## 2. Test Run #1 post-mortem — corrected

The handoff diagnosed two gaps. Both are real; the second is bigger than stated.

### 2.1 `files_referenced` path contract (fixed in this PR)
No description text — not the wire schema the operator model receives
(`gemini-operator.ts:209`), not the ORB registry (`tool-registry.ts:74`), not either
copy of the prompt prose — said paths must be repo-root-relative. The gate matches
anchored globs (`^services/gateway/src/services/.*$`), so `memory-relevance-scoring.ts`
can never match. Worse, the chat only ever saw `safety gate blocked approval`:
`executeExecuteTask` dropped `violations[]` before returning (`gemini-operator.ts:1281`),
so neither the operator nor the model could see which path or rule failed.

**Shipped:** all three description sites now state the contract with an example;
both prompt sources carry the identical rule (the VTID-03838 drift test still passes);
rejections now render as `safety gate blocked approval: file_outside_allow_scope
(memory-relevance-scoring.ts) — Plan touches 1 file(s) outside the allow-scope.`

### 2.2 The PR never satisfied the repo's governance contract (fixed in this PR)
`validate-pr` exit 10 ("no VTID") was only the **first** of eight gates the PR would
have failed. `VALIDATOR-CHECK.yml` triggers on `services/gateway/src/**` — exactly the
autopilot's allow scope — and requires:

| Gate | Requirement | Exit |
|---|---|---|
| VTID | `VTID-\d{4,5}` in the title, or a line starting `VTID: VTID-XXXXX` in the body | 10 |
| Profile | `VALIDATION_PROFILE: gateway_backend` in the body | 11 |
| Markers | `SCOPE_ALLOWLIST:`, `ACCEPTANCE:`, `MERGE_PAYLOAD_PREVIEW:`, `OASIS_IMPACT:` | 12-15 |
| Evidence pack | `docs/validation/<VTID>/{acceptance.md, commands.log, outputs/}` **committed in the diff** | 30-33 |
| Acceptance mapping | every `AC-n` line followed within 12 lines by `TEST:`/`CURL:`/`UI:` | 40-41 |
| Merge gate | VTID in the title | 90 |

The executor's prompt asked the model for `DEV-AUTOPILOT: short descriptive title` and
a free-text body; its LOCKED FILE LIST forbids adding `docs/validation/**`; its commit
messages use `VTID-DA-<exec8>`, which does not match the regex. So **no dev-autopilot
PR that touches gateway source could ever have passed** — the plane and the gate were
designed apart.

**Shipped:** `services/gateway/src/services/dev-autopilot-pr-contract.ts` — a pure
function that, given what the executor already has (`activated_vtid`, the emitted file
list, execution/finding ids, the serving model), stamps the VTID on the title, prepends
the full marker block to the body, and generates the three evidence files (acceptance
ACs mapped to the paired test file in the same diff, a commands.log of what the executor
did, an `outputs/execution.json` record). The executor writes them to the branch after
the empty-diff guard and before opening the PR; commits now carry the real VTID.
`test/dev-autopilot-pr-contract.test.ts` ports the workflow's own grep/regex checks so a
regression here fails locally before it fails in CI.

### 2.3 Why the reconciler lied
`dev-autopilot-watcher.ts:470` turns GitHub `mergeable_state:'blocked'` into the literal
string `"branch-protection blocked"` and that string becomes the triage prompt's only
evidence. Triage (`self-healing-triage-service.ts:302`) had its repo mount and OASIS
query tool removed, so it can only restate the label. The child execution then re-runs
the same prompt — the loop is closed on a false premise by construction. Not fixed here;
it is item R-7 below.

---

## 3. Capability gap matrix

Severity: **S1** blocks the goal outright · **S2** makes it unreliable/slow · **S3** quality-of-life.

### 3.1 Codebase awareness at session start — S1
| Claude Code session | Operator Console today |
|---|---|
| Full checkout, `git log`, CLAUDE.md (~121 KB), DATABASE_SCHEMA.md, service map, tests runnable | `CODEBASE_OVERVIEW_BLOCK` (`gemini-operator.ts:3428`): 6 hand-typed bullets, refreshed by editing a TS constant. No CLAUDE.md, no schema doc, no file tree, no git history. |
| Any file, any size, any ref | `dev_read_file` = GitHub Contents API, one file per call, `main` by default, large files throw; `dev_search_codebase` = GitHub Search API, 20 paths, files >384 KB invisible (`app.js` is 2.5 MB → permanently unsearchable). **Both off in production.** |
| Tool-result turn keeps the same context | The final answer after any tool call is composed under a *different, weaker* prompt ("You are Vitana, a friendly community assistant…", `gemini-operator.ts:3611`) with no codebase block and no memory. |

### 3.2 Execution engine — S1 (the core gap)
| Claude Code loop | Dev Autopilot plane |
|---|---|
| N turns; read → search → edit → run → observe → fix | **1 turn**, terminal. 2 LLM calls per ticket (plan, execute). |
| Surgical edits | Whole-file rewrite, ≤8 files, ≤200 KB each, 32k output tokens (truncation was the dominant failure class, VTID-02652) |
| `tsc`, jest, lint before commit | Impossible: `node:20-alpine`, no git, no repo, no toolchain (`Dockerfile.job`); `grep child_process` in the plane → 0 hits. Validation is CI *after* the PR. |
| Error → fix in-session | `{ok:false}`; retry = new row, same prompt, depth ≤2 |
| Runs anywhere | On prod the executor runs **inside the gateway request process** (`DEV_AUTOPILOT_USE_JOB` unset on `AWS-PROD-DEPLOY-GATEWAY.yml`), i.e. subject to container recycling — the exact watchdog failures logged 09-13. |

The one component that does clone, `npm ci`, `tsc --noEmit`, `jest --findRelatedTests`
and retry up to 3× is `services/autopilot-worker` (`repo.ts`, `validate.ts`, `retry.ts`)
— and it is documented as orphaned: not deployed, `DEV_AUTOPILOT_USE_WORKER` set nowhere,
and unconditionally bypassed by the on-ramp (`dev-autopilot-execute.ts:1618`). Even there
`claude -p` is used as a text-completion endpoint with `cwd` = the worker dir, not as an
agent with tools on the clone.

### 3.3 GitHub — S1 for vitana-v1, S2 for platform
Held (staging): branch/commit/PR/squash-merge on `vitana-platform`, workflow dispatch,
PR/check status. **Missing:** any write to `exafyltd/vitana-v1` (read-only via
`FRONTEND_DEPLOY_TOKEN`, only one workflow dispatch — every MAXINA frontend change in the
CHANGELOG was done by a session, never the console); reading Actions **job logs**
(`/actions/jobs/{id}/logs` is called nowhere — CI diagnosis is `conclusion` strings +
`mergeable_state`, which is what produced the wrong triage); PR review comments/labels;
dispatch paths for the non-gateway `AWS-*-DEPLOY-*.yml` workflows. Three separate
token-resolution ladders (`github-service.ts:25`, `dev-autopilot-execute.ts:942`,
`dev-autopilot-bridge.ts:49`) — consolidate.

### 3.4 AWS admin — S1 on prod, S2 on staging
Runtime SDK clients: ECS (RunTask + DescribeServices on a 9-name allowlist), Bedrock,
Polly, Transcribe, S3, Cognito. **Absent:** CloudWatch Logs, Secrets Manager, ECR, IAM/STS,
`ecs:UpdateService`/`RegisterTaskDefinition`/`DescribeTaskDefinition`. The only log
workflow (`DEBUG-GATEWAY-LOGS.yml`) still authenticates to GCP — dead. `ecs:RunTask` /
`iam:PassRole` on the staging gateway role and `bedrock:InvokeModel` on the executor role
are still **unverified live** (VTID-03850/03851 record). Prod task-def credentials
(`GITHUB_SAFE_MERGE_TOKEN`, `SUPABASE_*`, `DEEPSEEK_API_KEY`) are live-only — not declared
in `AWS-PROD-DEPLOY-GATEWAY.yml`, so unreviewable from the repo and a rotation would be a
hand edit (the VTID-03513 trap). Platform-owner decision on record (VTID-03929): the
operator's AWS identity "must have the maximum broad one" — that decision has not been
executed as IAM.

### 3.5 RepoWise / Graphify indexes — S1
No index of any kind is wired to the console or the executor. The only mention of
`repowise`/`graphify` in gateway source is the comment at `gemini-operator.ts:3412` saying
they cannot run in the container. `services/mcp-gateway` (an MCP connector hub) is
dormant and unreferenced by `services/gateway/src`. The mandatory workflow in CLAUDE.md is
therefore unsatisfiable for the console, and for sessions like this one.

### 3.6 Cross-session memory — S2
`dev_agent_memory` (Titan v2 embeddings, `recall_dev_memory` RPC) is a good substrate,
but: recall is top-5 on the raw user message only (`gemini-operator.ts:3795`); writes
happen only when one of five tools succeeds (`routes/operator.ts:112`) — no decisions,
preferences, gotchas, failures, or plain conversations are ever remembered; the executor
and on-ramp never read or write it; there is no thread summary/compaction; and transcripts
are `localStorage` — a new browser, a cleared cache, or a colleague sees nothing.
`GET /api/v1/operator/chat/:threadId` (backed by `oasis_events`) exists but the UI never
calls it. `threadIdentityMap` / `threadAuthMap` are in-process Maps lost on every deploy.

### 3.7 Real-time status awareness — S2
Read tools exist for the ledger, OASIS events, one ECS service, 4 allowlisted tables,
deployment status and the internal approvals queue. **Missing:** live PR + check-run state
for arbitrary PRs, workflow-run logs, CloudWatch logs, the 55-probe Service Health panel
(browser-only fetch loop, no tool), ALB/target-group state, OASIS *stream* subscription,
`git log`/diff, and any snapshot of these at session start. `investigate_failure`,
`recall_conversation_at_time` are dispatchable but undeclared to the model.

### 3.8 Governance friction — S2
- `VALIDATOR-CHECK` contract (fixed for the executor here; the `docs/validation/**`
  evidence pack assumes CI-verifiable ACs — the Route Mount gate will still block a PR
  that *adds* a route, because `ROUTE_MOUNT:/FINAL_URL:/CURL_PROOF:` need a real curl).
- The on-ramp requires a pre-existing, `spec_status='approved'` VTID, while CLAUDE.md
  rule 2b says a session self-allocates and self-approves for operator-instructed work.
  The console should do the same in one step (`autopilot_create_task` +
  `spec_status='approved'` when the exafy_admin asked for it in conversation).
- `dev_autopilot_config.allow_scope` excludes `docs/**`, `supabase/migrations/**`,
  `scripts/**`, `.github/**`, and all of `vitana-v1` — a large share of real daily work.
- `daily_budget=500`, `concurrency_cap=4`, `cooldown 1 min` — fine; `max_auto_fix_depth=2`
  is wasted while retries re-run the same prompt.

### 3.9 Environment gating — S1 for "production operator"
Staging pins `OPERATOR_EXECUTION_ONRAMP_ENABLED`, `OPERATOR_CODEBASE_READ_ENABLED`,
`OPERATOR_DB_READONLY_ENABLED`, `OPERATOR_AWS_READONLY_ENABLED`, `OPERATOR_PLANNER_ENABLED`,
`DEV_AUTOPILOT_USE_JOB`, `DEV_AUTOPILOT_JOB_CLOUD=aws`, `DEV_AUTOPILOT_WATCHER_LIVE`.
**Prod pins none of them** except the on-ramp (applied 09-16 via `env-only`). So the prod
console can queue a code execution but cannot read the code it is changing, cannot see
the DB or ECS, runs the executor in-process, and its watcher is in DRY_RUN — which
*fabricates* merge/deploy transitions (`dev-autopilot-watcher.ts:44`).

### 3.10 UI / UX — S3
No token streaming (single `await fetch`), no tool-call transcript (one line per tool,
no args/results/errors), no diff preview or patch approval, no plan approval in-console,
no cancel, no cost/model display (`meta.provider/model` returned but never rendered),
execution progress lives on a different screen (`/executions/:id/stream` SSE exists) with
nothing linking the chat's `execution_id` to it.

### 3.11 Security hygiene — S1 (independent of the goal, but blocks safe experimentation)
- The Supabase `service_role` key rotation flagged in `docs/HANDOFF-voice-quality.md:65`
  ("the earlier key was exposed and should be rotated") has **no confirmation anywhere**
  — not in CLAUDE.md's CHANGELOG, not in git. Still open.
- `CLAUDE.md:1920-1921` prints partial live PATs as the documented way to use the API.
- Test Run #1 was executed **on production** with a real execution; vitana-v1's absolute
  rule forbids testing against production. Run #2/#3 belong on staging (§6).

---

## 4. Target architecture — the "Operator Execution Agent"

```
Command Hub chat ──▶ /api/v1/operator/chat (server-side session, streaming)
                          │  bootstrap pack (§4.1)  +  memory recall/write (§4.3)
                          ▼
                 Operator model (policy 'operator')  ── read tools (§4.4) ──▶ GitHub / AWS / DB / index
                          │ autopilot_execute_task (self-allocates VTID, approves)
                          ▼
            dev_autopilot_executions row ──▶ ecs:RunTask  vitana-autopilot-agent   (§4.2)
                                                │  real clone · CLAUDE.md · index · tsc/jest
                                                │  Claude Code headless on Bedrock, tools on the repo
                                                ▼
                        PR with validator contract (this PR) ──▶ CI ──▶ watcher (log-aware) ──▶ merge/deploy
```

### 4.1 Session bootstrap pack (replaces `CODEBASE_OVERVIEW_BLOCK`)
Assemble per thread, cache 5 min, ~20-40 KB: CLAUDE.md Part 1 rules + the §1b/§2 tables;
`config/service-path-map.json`; DATABASE_SCHEMA.md table index; the last 20 CHANGELOG
rows; live `build-info` for staging + prod; open PRs on both repos with check state;
last 10 `oasis_events` of type `deploy.*`/`dev_autopilot.*`; the top-10 memory recall
against the *thread summary*, not the raw message; the tool catalog rendered from the
declarations (never a hand-typed list). Same prompt for tool-result turns.

### 4.2 Agentic executor (`vitana-autopilot-agent`)
Revive `services/autopilot-worker` as a deployed one-shot ECS task, not a workstation
daemon: image with git + Node 20 + a shallow clone of both repos refreshed per run;
Claude Code CLI in headless mode **on Bedrock** (`CLAUDE_CODE_USE_BEDROCK=1`, the task
role's `bedrock:InvokeModel` — no `ANTHROPIC_API_KEY`, which keeps ALWAYS 10a/10b), with
`cwd` = the clone so the model has Read/Grep/Edit/Bash tools on the actual repository;
the executor prompt becomes "implement VTID-X per this plan; run tsc and the related jest
suites; commit on `dev-autopilot/<exec8>`; stop" instead of "emit all files". Keep the
existing safety gate, LOCKED-scope check (post-hoc on `git diff --name-only`), coverage,
and PR-flood guards; keep the PR contract from this PR. Fallback lane when Bedrock Claude
is unavailable: the same runner with the router's DeepSeek model through a tool-calling
loop (the `worker` policy fallback), never the single-shot path. Bounded: 25-minute task
timeout, 3 validation attempts, cost recorded per run in `dev_autopilot_outcomes`.

### 4.3 Memory that actually accrues
Server-side `operator_threads` / `operator_messages` tables (the `oasis_events` audit
row stays); a thread summary written on every 10th turn and at close; `writeDevMemory`
on decisions/gotchas/failures/preferences extracted by the `memory` policy stage from each
completed turn (not only five tool names); the executor writes `task_outcome` +
`gotcha` rows from each run (validation failures, CI failure reasons); recall query =
summary + current message, top-10, category-diverse.

### 4.4 Access to build, in this order
1. GitHub Actions **job logs** (`getJobLogs`) — unblocks honest triage and CI-red
   handling; 2. `vitana-v1` write path (branch/commit/PR/merge) with the same safety gate
   and a frontend `allow_scope`; 3. CloudWatch `logs:FilterLogEvents` on `/ecs/vitana-*`;
   4. `ecs:DescribeTaskDefinition/DescribeTasks/ListTasks` (read) and the deploy-workflow
   dispatch table for every `AWS-*-DEPLOY-*.yml`; 5. an explicit `dev_run_sql_readonly`
   over the Aurora reader (bounded, logged) instead of the 4-table PostgREST allowlist;
   6. Secrets Manager `GetSecretValue` for the operator's own secrets only. Each grant is
   its own VTID and is declared in the deploy workflow, never hand-edited on the task def.

### 4.5 Index service
Build RepoWise + Graphify in CI on every merge to `main` (both repos), publish
`graph.json` + the RepoWise index to S3, and expose `dev_index_query` /
`dev_graph_path` / `dev_get_risk` tools in the gateway that read the published artifact
for the commit the session is on. Same artifacts are pulled into the agent task at start,
which finally makes CLAUDE.md's "Mandatory Codebase Intelligence Workflow" satisfiable for
the console, the agent, and Claude Code sessions alike.

### 4.6 Console UX
SSE streaming for the operator turn (the `/executions/:id/stream` pattern already
exists); a tool-call transcript with args/result/duration; the queued execution's live
steps inline in the chat; a diff preview with Approve/Reject before the PR is opened
(commit-tier, like the BackOffice maker-checker); cost/model badge; cancel.

---

## 5. Roadmap (each row = one VTID, one PR; ordered by leverage ÷ risk)

| # | Slice | Unblocks | Size |
|---|---|---|---|
| R-0 | **This PR** — path contract, violations surfaced, validator-compliant PR contract + evidence pack | Run #2 can pass `validate-pr` | done |
| R-1 | Pin the operator/autopilot flag set + `DEV_AUTOPILOT_USE_JOB=true`/`JOB_CLOUD=aws` on **prod** via `env-only`; verify `ecs:RunTask`/`iam:PassRole`/`bedrock:InvokeModel` live | Executor stops running inside the gateway; prod console can read code/DB/ECS | S |
| R-2 | Actions job-log reader + watcher passes failing check names/log excerpts to triage; triage regains an OASIS query tool | Honest CI diagnosis; ends the "branch protection" false loop | S |
| R-3 | Bootstrap pack (§4.1) + rendered tool catalog + same prompt for tool-result turns | Session-start awareness | M |
| R-4 | On-ramp self-allocates + approves the VTID for exafy_admin-instructed work; `docs/validation/**`, `docs/**`, `scripts/**` in allow_scope | One-step "do this" from chat | S |
| R-5 | Server-side threads + summaries + broad memory writes (§4.3) | Cross-session memory | M |
| R-6 | Agentic executor task on Bedrock (§4.2), behind `DEV_AUTOPILOT_EXECUTOR=agent` | Claude-Code-quality execution, local tsc/jest before PR | L |
| R-7 | `vitana-v1` write lane + frontend allow_scope + preview-deploy verification | MAXINA work from the console | M |
| R-8 | Index service (§4.5) | Knowledge-graph awareness | M |
| R-9 | Console UX: streaming, transcript, inline execution steps, diff approval | Operator trust | M |
| R-10 | CloudWatch logs + ECS describe + read-only SQL tools; IAM as declared workflow state | AWS admin awareness | M |
| R-11 | Security: confirm/perform service_role rotation; remove PATs from CLAUDE.md; declare prod secrets in the workflow | Safe to keep experimenting | S |

### Test runs (all on **staging**, `preview-aws-gateway.vitanaland.com`, per vitana-v1's rule)
- **Run #2 (after R-0):** a two-file change that needs a *new* test file (e.g. add a
  pure helper under `services/gateway/src/services/` + `test/<name>.test.ts`). Success =
  PR passes `validate-pr` end to end, CI green, watcher merges on staging.
- **Run #3 (after R-1/R-2):** a fix that requires reading a file *not* in the plan
  (a caller of the changed function) — expect the single-shot executor to fail on scope
  or coverage; this is the measurement that motivates R-6.
- **Run #4 (after R-6):** the same task as Run #3 on the agentic executor; compare
  wall-clock, PR-diff size, CI outcome, and cost from `dev_autopilot_outcomes`.

---

## 6. What this PR changes, and what it does not verify

Changed: `tool-registry.ts`, `gemini-operator.ts` (schema text, prompt rule, violation
rendering), `ai-personality-service.ts` (prompt rule, identical), new
`dev-autopilot-pr-contract.ts` + wiring in `dev-autopilot-execute.ts` (contract applied,
evidence files written after the empty-diff guard, real VTID in commit messages),
`test/dev-autopilot-pr-contract.test.ts` (18 tests mirroring the validator's own checks).
`tsc --noEmit` clean; 8 affected suites 103/103 green locally.

Not verified: a real on-ramp execution through the new contract (that is Run #2, on
staging); the Route Mount gate for PRs that add routes remains an honest gap; the
`OASIS_IMPACT: no` default is correct for the autopilot's current allow scope but must
be revisited if the scope grows to files that emit events.

---

## 7. Test Run #2 — executed on staging 2026-09-17 17:01 UTC (VTID-04003, execution `e3ca9a1d`, PR #3372)

**Result: pass, first attempt, no human intervention between the chat message and a green PR.**

| Step | Time (UTC) | Evidence |
|---|---|---|
| Chat message → `autopilot_execute_task` called with correct repo-root-relative paths | 17:01:02 | `toolResults[0].response.status = "queued"`; governance L4 allowed; safety gate passed (the path-contract fix held on the first try) |
| Claimed by the staging gateway (`env: staging`) | 17:01:10 | `dev_autopilot.execution.running` |
| LLM call on `deepseek/deepseek-flash` | 17:01:36 → 17:02:14 (38 s) | `llm.call.completed` tagged `VTID-04003` |
| PR #3372 opened by the **ECS executor task** (`env: production` tag on `pr_opened`, a different process from the staging gateway that claimed it) with the VTID-04002 contract applied | 17:02:24 | title `… (VTID-04003)`, body starts `VTID: VTID-04003` + all markers, `docs/validation/VTID-04003/{acceptance.md,commands.log,outputs/execution.json}` in the diff, commits `VTID-04003: modify/create …` |
| CI: all 18 checks green, **`validate-pr` passed** (the gate that reverted Run #1) | 17:04:46 | Gateway jest suite green; the new `dev-autopilot-watcher-failure-reason.test.ts` ran in CI |
| Squash-merged to `main` by this session | 17:12 | `f79d51c` → staging auto-deploy |

Code quality: the diff matches the plan exactly — `buildCiFailureReason()` exported next to the other pure analyzers,
the inline ternary replaced, nothing else touched, 9 tests covering every branch including the regression
assertion ("blocked with names never says branch protection"). Two cosmetic nits only: a dropped trailing newline
in both files.

**Confirmed live by this run (was "unverified" in §3.4):** the staging gateway role holds `ecs:RunTask` +
`iam:PassRole` for the executor task, and the executor task's role holds `bedrock`/DeepSeek access — the PR was
opened by the one-shot ECS task, not by the in-process fallback.

### New finding: the PROD gateway's dry-run watcher "completed" a staging execution
`dev_autopilot.execution.ci_passed / pr_merged / deployed / completed` all carry `env: production`,
`service: dev-autopilot-watcher`, and the message suffix `(dry-run synthetic)` — and `vtid.lifecycle.completed`
terminalized VTID-04003 as `success` at 17:08:01 while PR #3372 was still **open**. Mechanism: prod and staging
share one `dev_autopilot_executions` table; prod's gateway runs `ciWatcherTick()` with `DRY_RUN=true`
(`DEV_AUTOPILOT_WATCHER_LIVE` is pinned on staging only), and the dry-run branch synthesizes every transition
after `DRY_RUN_SETTLE_MS` without looking at GitHub. Staging's live watcher never got the row because prod's
tick won the race. Consequences: (1) the ledger can report `success` for code that never merged; (2) staging's
live auto-merge is effectively disabled whenever prod's tick runs first. Fix (adds to roadmap R-1): either pin
`DEV_AUTOPILOT_WATCHER_LIVE=true` on prod too, or make the watcher skip executions whose `metadata.env` (to be
stamped at claim time) is not its own — never let a dry-run process transition a real execution.

## 8. Test Run #4 / #4b — the agent executor on staging, 2026-09-17 19:28–20:15 UTC (VTID-04008 → VTID-04012, PR #3382)

Design (§5 test runs): the Run #3 task shape — a change whose **only caller is not in `files_referenced`** — on the
agent executor (W1, VTID-04006), after #3375 merged, the executor image was rebuilt (run #7, `aa636f8`) and
`OPERATOR_ONRAMP_EXECUTOR=agent` was pinned on the staging gateway (#3376). Task: `renderCiEvidence()` gains
`totalFailing`, and the one caller in `dev-autopilot-watcher.ts` — deliberately left out of the plan — must pass
`analysis.failedNames.length`. Run #3 (single-shot) could not touch that file; this is the capability under test.

### What the agent did (execution `47a4d6eb`, then `4f7d5ea4`)

| Step | Run #4 (`47a4d6eb`, exec image rev 9) | Run #4b (`4f7d5ea4`, rev 10 = +VTID-04009) |
|---|---|---|
| Chat → `autopilot_execute_task` → row queued with `metadata.executor='agent'` | 19:28:43 → 19:28:50 | 20:05:57 → 20:06:04 |
| Claimed by staging; ECS task dispatched with `EXEC_ID` | 19:29:08 / 19:29:35 | 20:06:31 / 20:06:51 |
| `read_file` both plan files → `search_text renderCiEvidence\(` → `read_file dev-autopilot-watcher.ts` (**the unlisted caller, found**) → `edit_file` ×3 | turns 1–11, 19:29:49–19:30:11 (22 s) | turns 1–7, 20:07:01–20:07:20 (19 s) |
| `run_check tsc` | **OOM** (V8 `allocation failure` at ~2 GB, 140 s) ×9 across 44 turns | completes in 53 s; **TS2742** (symlinked node_modules) |
| `run_check jest` on the changed test + the watcher suites | green (turns 14, 16) | green (turns 12, 15, 17, 20) |
| Self-repair | deleted the `core.*` dumps it found via `git_diff` | added an explicit return-type interface to `connect-people-repository.ts` + 2 tests, tsc clean (turn 16) |
| `finish` → runner: scope ✓, `runner:tsc`, `runner:jest` | never reached (see below) | 20:14:07 → tsc clean 20:14:58, jest green 20:15:00 |
| PR | none | **#3382** at 20:15:04, 5 files, DeepSeek Flash end to end, **9 min 07 s** from chat to PR; 18/18 checks green incl. `validate-pr`; squash-merged 20:23 as `e104099` |

The capability gap Run #3 exposed is closed: the agent located and edited a file it was never handed, ran the
checks before opening the PR, and iterated on their output. The diff is better than the plan asked for — the
"…and N more failing check(s) not fetched" line reserves its own budget so truncation can never drop it (Run #3's
single-shot sibling #3379 appended it after the cap and could lose it).

### Three executor defects found by the run, each fixed the same evening

| # | Defect | Evidence | Fix |
|---|---|---|---|
| 1 | `tsc` on the gateway needs more than V8's default ~2 GB old-space; the 4 GB task never mattered | nine `allocation failure` aborts, core dumps in the clone; locally tsc peaks at 2497 MB RSS with a 3 GB heap (47 s) | **VTID-04009** (#3377): `runTsc` passes `NODE_OPTIONS=--max-old-space-size=<AGENT_CHECK_HEAP_MB=3072>` |
| 2 | The 20-min running-watchdog reclaimed the **live** execution at 19:49:37 (nothing refreshed `updated_at` after the claim; the agent deadline is 22 min), and its PATCH — like `applyExecutionResult`'s failure PATCH — **replaced** `metadata`, wiping `executor`/`claimed_env`/`llm_on_ramp_override`. The self-heal child `8b2bce93` therefore ran **single-shot on Bedrock** and opened #3379 (correct `renderCiEvidence`, caller untouched — closed) | `dev_autopilot_executions` rows + `oasis_events`; the parent kept emitting `dev_autopilot.agent.*` steps until 19:53:46, four minutes after its "reclaim" | **VTID-04011** (#3380): both PATCHes merge via pure `buildWatchdogReclaimPatch` / `buildExecutionFailurePatch`; `agent-heartbeat.ts` bumps `updated_at` every 60 s while the agent runs |
| 3 | The clone's `node_modules` is a symlink to `/app/node_modules`, so tsc resolves realpaths outside the project → `TS2742` on a library-inferred export type; clean on a real install | Run #4b turn 8 + `runner:tsc` (path ends in `…/app/node_modules`) | **VTID-04013** (#3381): `--preserveSymlinks` on the agent's tsc |

Also observed, not fixed here: the model re-ran an identically failing `tsc` nine times (≈18 min of a 22-min
budget) — the loop needs a repeated-identical-check guard; the PR contract's `commands.log` describes the
single-shot flow ("parse PR_TITLE/FILE blocks … the executor itself does not run them"), which is wrong for the
agent path; the production gateway's dry-run watcher (prod is not on VTID-04004/04005) still synthesized
`ci_passed`/`pr_merged` on the staging-claimed child — the §7 finding, unchanged until prod is promoted; and
two EventBridge Scheduler entries (`vitana-gateway-remi…`, `vitana-push-dispatc…`) launch stale
`vitana-autopilot-executor:2` tasks every few minutes that exit with code 2 — outside this run, flagged to the
owner (this session's IAM cannot list schedules).

### Run #3 vs Run #4b

| | Run #3 (single-shot, VTID-04004) | Run #4b (agent, VTID-04012) |
|---|---|---|
| Reads a file not in the plan | no — cannot | yes (`search_text` → `read_file`) |
| Runs tsc/jest before the PR | no (CI only) | yes, and the runner re-verifies independently |
| Reacts to a failing check | no | yes — 2 fix rounds (jest on its own test, TS2742) inside one execution |
| Chat → PR | ~82 s | 9 min 07 s (53 s of it one tsc; the rest model turns at 1–8 s each) |
| Model | DeepSeek Flash (one call) | DeepSeek Flash, 40 turns in total (23 + 1 fix round), no Bedrock fallback used; 1,040,899 input / 28,696 output tokens (the transcript is re-sent every turn — the input figure is the cost driver, and the case for W3's transcript compaction) |
| PR completeness vs plan | incomplete (caller untouched) | complete, plus a scoped type-annotation workaround |

## 9. W2 — open-ended intake, shipped 2026-09-17 (VTID-04007), plus the executor hardening Run #4b asked for (VTID-04016)

**What changed the console's capability.** Before W2 the console could execute only an already-named VTID with a pre-listed file set. `autopilot_run_task(request, title?)` closes the intake half of gap §3.1: the operator says what should change, the on-ramp allocates and registers the VTID itself (W0's server-side self-allocation, still behind `OPERATOR_VTID_SELF_ALLOCATE_ENABLED`), the execution row is pinned to the agent executor (the single-shot path refuses a plan with no files, so the row — not the env — decides), and the agent's task prompt switches to discovery mode: search first, smallest change, no invented requirements, name the reading taken when the request is ambiguous. Every file-level rule the safety gate would have applied to a pre-listed plan is applied to the agent's real diff after it finishes (`checkChangedFilesScope`, `hasTestCoverage`, runner tsc + jest — VTID-04006). Nothing new is bypassed: kill switch, daily budget, self-heal depth and the VTID-03851 exafy_admin marker still run first.

**What did not change.** The tool is declared and wired but inert on staging until the owner sets `OPERATOR_VTID_SELF_ALLOCATE_ENABLED=true` on the staging gateway (the plan reserved that flip, and this session did not make it); until then it answers with the same honest refusal `autopilot_execute_task` gives without a VTID. Production pins none of the operator flags (§7 finding, unchanged).

**Executor hardening (VTID-04016).** The Run #4/#4b transcripts showed the model re-running an identically failing `tsc` ten and three times respectively with no edit in between. `run_check` now refuses a `(kind, target)` check that has already failed twice since the last file mutation, before it runs, and the PR contract's `commands.log` describes the agent path (clone, tool loop, guard, runner checks, fix rounds) with `turns` / `fix_rounds` / `checks_refused_by_guard` / `fallback_used`, instead of the single-shot flow it was written for.

**Run #5 design (unchanged from the plan):** on staging, as the `operator-autopilot@exafy.io` exafy_admin, a vague request with no VTID and no files — "the CI failure reason should name the checks" is now taken (VTID-04003), so use a different, equally small real gap. Success = VTID allocated with `intake:'open_ended'`, `executor:'agent'` on the row, PR green through `validate-pr`, diff inside scope, and `checks_refused_by_guard` reported in the evidence pack.

## 10. W3 — the CI feedback loop stops starting over (VTID-04017), shipped 2026-09-17

**The loop as it was.** CI red on a Dev Autopilot PR → triage → `revertExecutionPR` closes the PR and deletes the branch → a child execution re-runs the same plan on a fresh clone of `main` and opens a new PR. The parent's work was discarded even when the fix was one line, and the W0 log excerpt was only a paragraph in a prompt that otherwise said "start from the plan". Two latent defects sat on the same path: the PR-flood guard in `runExecutionSession` refuses any child whose parent row still carries a `pr_url` (the parent is `reverted`, which the guard's exclusion list does not cover), and the child was told about a branch that had just been deleted.

**The loop now (agent-executor parents, stage `ci`, not DRY_RUN).** The PR stays open. The child row carries `metadata.fix_mode = { branch, pr_number, pr_url, parent_execution_id }` beside the inherited executor/override and `parent_failure`. The runner clones the PR branch itself, fetches `main` to diff against, and gives the agent a fix-mode task: the original request, the files the PR already changes, the failing jobs' own log excerpts, and the attempt count. It must reproduce the failure with `run_check` before editing, may not delete or skip a test to get green, and may not start over or open a new PR. Post-hoc scope, coverage, tsc and the paired jest suites run on the whole PR diff; a run that edited nothing is refused; the commit is fast-forwarded onto the same branch and the child returns the parent's PR, so the watcher's `ci → merging → deployed → completed → parent self_healed` chain is untouched. Depth is still capped by `max_auto_fix_depth`; at the cap the bridge escalates and leaves the PR open, red, for the human it escalates to. Single-shot parents and merged-then-broken changes (`deploy`/`verification` stages) keep the revert path.

**Cost per run.** The agent runner now appends `{ execution_id, provider, model, input/output tokens, cost_usd (estimateCost), turns, fix_rounds, checks_refused, fallback_used, fix_mode, outcome }` to the finding's latest `dev_autopilot_outcomes` row (`metadata.agent_runs[]`, `agent_cost_usd_total`) on every exit path — the number the plan's W3 row asked for, without a migration.

**Not verified live.** Test Run #6 (plan): an agent PR whose first attempt breaks a paired test, then the same PR going green from a fix-mode child with no second PR.

## 11. W4a — the session bootstrap pack (VTID-04018), shipped 2026-09-17

§4.1 asked for the console to start each turn the way a Claude Code session does. `operator-bootstrap-pack.ts` now assembles, per turn, the CLAUDE.md Part 1 rules and the newest 20 change-log rows (GitHub contents API — the container has no CLAUDE.md), the service path map, the `DATABASE_SCHEMA.md` table index, live `build-info` for the gateways named in `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS`, open PRs on both repos (platform with CI state), the last 10 `deploy.*`/`dev_autopilot.*` OASIS events, and the tool catalog rendered from the declarations the model is actually given — the hand-typed tool list in the prompt is now the floor, not the ceiling. Every source is bounded, timed out at 2.5 s and fails open to one `(unavailable: …)` line; the fetched sections are cached for 5 minutes with coalesced concurrent builds; the pack is capped at 40 KB and appended to both the main turn and the tool-result turn. Gated on `OPERATOR_BOOTSTRAP_PACK_ENABLED` (pinned on staging). Still open from §4.1: recall against a thread summary rather than the raw message — that needs the server-side threads of §4.3 (W4b).

## 12. W5a — CloudWatch logs for the console (VTID-04020), shipped 2026-09-17

§4.4 item 3. `dev_cloudwatch_logs` reads the last N minutes of one `/ecs/vitana-<service>` log group through `FilterLogEvents` — the only CloudWatch API the module imports — with the window, the event count and the payload bounded, behind the same `OPERATOR_AWS_READONLY_ENABLED` flag and `dev_*` role gate as the ECS status tool. The log-group shape is enforced before any AWS call; an IAM denial comes back verbatim. Whether the gateway task role (the broad one, VTID-03929) actually holds `logs:FilterLogEvents` cannot be checked from a session whose own user may not list that role's policies — the first call on staging says so, and the grant, if missing, is declared in the deploy workflow by the owner (§4.4's rule: never hand-edited on the task def). Item 4 (`ecs:Describe*`) already existed; item 5 (read-only SQL over the Aurora reader) and the `vitana-v1` write lane are W5b.

## 13. W4b — server-side threads and rolling summaries (VTID-04022), shipped 2026-09-17

§4.3 named the console's memory problem: a browser-only transcript and a recall that ran against the raw current message. Two tables (`operator_threads`, `operator_messages` — migration shipped as a file, applied on the owner's go) now hold every turn server-side, and each thread carries a rolling summary rewritten every ten turns by the `memory` routing stage from the last thirty messages plus the previous summary. `processWithGemini` recalls `dev_agent_memory` against `Conversation so far: <summary>` + `Current message: <text>` when a summary exists, so a turn like "now rebuild the image" retrieves what the thread is actually about instead of matching three words. The whole path is fail-open by construction: the kill switch (`OPERATOR_THREADS_ENABLED`) is off by default, a missing table warns once and records nothing, and neither a Supabase nor a router failure can touch the reply — recording runs after the response is computed and off its critical path. What §4.3/§4.6 still owe: memory writes from every tool outcome (today five tool names write `task_outcome` rows), SSE streaming of the turn with the tool transcript, and the diff preview + Approve step before a PR opens.

## 14. W5b (read-only SQL) — `dev_run_sql_readonly` (VTID-04023), shipped 2026-09-17

§4.4/§4.5 wanted the console to ask the database real questions. `dev_db_query` (VTID-03837) stays as the cheap path for the four allowlisted tables; beside it, `dev_run_sql_readonly` runs one SELECT / WITH … SELECT / plain EXPLAIN over a connection that exists for nothing else (`OPERATOR_SQL_READONLY_DATABASE_URL`, a read-only login role on the Aurora reader — deliberately not the `vitana_admin` URL the i18n seam uses nor the `authenticator` URL the RLS diagnostic uses). The statement is validated before any connection is opened (single statement, comments stripped, no data-modifying CTE, no locking clause, no `pg_sleep`/file/backend-signalling/`set_config`/`dblink`/large-object/`nextval`/SELECT INTO), then executed inside `BEGIN READ ONLY` with local statement/lock/idle timeouts and always rolled back, wrapped in `LIMIT n+1` with cells and payload bounded. Each execution logs a statement fingerprint, so the CloudWatch log W5a exposed is the audit trail. It ships inert (`OPERATOR_SQL_READONLY_ENABLED` off, no URL anywhere) and reports `not_configured` honestly until the owner provisions the role and wires the secret into the staging task definition — the first call on staging is the exercise. The rest of §4.5 — a dispatch table for the deploy workflows and the `vitana-v1` write lane — remains owner-gated on a frontend write token.

