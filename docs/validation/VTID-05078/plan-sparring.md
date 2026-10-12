# Plan sparring record — VTID-05078 (Dev Autopilot autonomy, Phase B)

Phase B of the master plan sparred under VTID-05077 — same plan, same hash, same owner approval:

- Sparring id: `plan_sparring_sessions` `64590d1b-cdff-4348-b4e0-30354287e2ee` (recorded on VTID-05078 as `metadata.master_plan_sparring_id`; the ledger keeps `sparring_id` unique to VTID-05077)
- Plan hash: `2c184d7b1ba74e2a70eb57b240bea2e1c45b4cb3e5bbb47688414daa44fe4172`
- Change class: standard · 3 rounds · verdict **CONVERGED**
- **Owner approval:** 2026-10-12, Claude Code session https://claude.ai/code/session_019XRHThojRVzYPDzoLtuby6 — "yes" (Gate 1, phases A–E); Phase B started on the owner's "start Phase B".

<!-- plan:begin -->
## Change class
standard. Master plan; each phase below is its own VTID and PR, executed in order A → B → C → D → E, then the staged rollout F (config only).

## Owner direction (2026-10-12)
- Turn the Dev Autopilot on so self-healing and self-improvement run nonstop, without colliding with Kiro IDE, the Operator Console's Kiro, or Claude Code sessions working in parallel.
- The planner stays on DeepSeek (DeepSeek-V4.1-Flash, model id `deepseek-flash`); its fallback is Bedrock Claude Opus 4.6 (thinking model for planning). The coding agent stays on Bedrock Claude Sonnet 4.6. Different models are meant to check and improve each other's work.
- The planner must have read access to both repositories (`exafyltd/vitana-platform`, `exafyltd/vitana-v1`) and to the codebase index, not one pre-fetched file.

## Verified facts (2026-10-12, main c69d521d + live DB, read-only)
1. Kill switch is armed: `dev_autopilot_config.kill_switch=true` (armed by `20260430120000_BOOTSTRAP_pause_dev_autopilot_auto_approve.sql` after duplicate-PR floods). Live config: `auto_approve_enabled=false`, `concurrency_cap=4`, `daily_budget=500`, `cooldown_minutes=1`, `allow_scope` includes `services/gateway/src/**` and `services/gateway/src/frontend/command-hub/**`.
2. Outcomes since 2026-09-18: 0 completed, 14 reverted, 6 failed, 5 failed_escalated; 4 executions sitting in `ci` with PRs #4016–#4019 (opened 2026-09-28..10-01).
3. Planner: `devPlannerModel()` = deepseek/deepseek-flash (`dev-pipeline-models.ts:26`), called via `callViaRouter('planner', …, {maxTokens: 8000, allowFallback: true})` (`dev-autopilot-planning.ts:171-198`). Last 7 days: 246 DeepSeek planner calls, 128 failed with "returned no text: output cap reached (stop_reason=length, output_tokens=8000)"; each of those 128 was then served by the router fallback, Bedrock `global.anthropic.claude-sonnet-4-6`. So ~half of all plans are not written by DeepSeek. `dev_autopilot.plan.failed` events (175 in 21 days) report only "Plan generation failed after Ns: unknown error".
4. Planner context: one file, `finding.spec_snapshot.file_path`, fetched from `DEV_AUTOPILOT_REPO || 'exafyltd/vitana-platform'` @ main via the GitHub contents API, capped at 600,000 chars (`dev-autopilot-planning.ts:98,105,200-227,876-901`); plus live DB columns of referenced tables, an embedded conventions string (`dev-autopilot/context-loader.ts`) and recent scanner lessons. No other file, no callers/tests, no code index, no `vitana-v1`. Symptom: plans name non-existent or wrong paths (e.g. a plan on 2026-10-11 listed a new file under `supabase/migrations/` — denied scope — and tests under `services/gateway/tests/` beside the main `test/` tree).
5. Coding agent (`autopilot-agent/run-agent-execution.ts`): clones `exafyltd/vitana-platform` only (`:51-53`), pulls a code index (`pullCodeIndex`, `agent-workspace.ts:337`), runs tsc/jest, opens a `dev-autopilot/<exec8>` PR, stops at `awaiting_approval` when `DEV_AUTOPILOT_PR_APPROVAL_REQUIRED=true`.
6. Collision guards: none against open human PRs. Before merge the watcher only compares the PR with main (`dev-autopilot-watcher.ts:265-293, 679-742`); the PR-clash gate is observe-only (`jev/gates/pr-clash-gate.ts`); the path lock manager is in-memory and unused by the watcher; the autopilot auto-squash-merges green low/medium PRs (`dev-autopilot-watcher.ts:891-948`).
7. Governance: one VTID per finding via `ensureFindingVtid` → `allocate_global_vtid` with no sparring record; the `vtid_ledger` sparring trigger is in log mode, so this passes silently. Pre-merge LLM review lets the merge through when the review call itself fails (`dev-autopilot-llm-review.ts:229`).
8. Production: no autopilot or self-healing code dispatches a production deploy; merges reach staging only. Production stays behind PUBLISH / Gate 2.

## Phase A — make the pipeline land changes again (VTID A)
A1. Planner output cap — diagnose first, then one fix. Step 1: log on staging, for 20 planner calls, DeepSeek's raw `usage` (incl. `completion_tokens_details.reasoning_tokens` if present), `finish_reason`, and whether `reasoning_content` is returned — this settles whether `deepseek-flash` spends the cap on reasoning or on plan text. Step 2, by the evidence: reasoning tokens → request the model's non-reasoning mode for this call (the documented API field, verified in DeepSeek's docs at implementation time) and keep the cap; plan text → raise the planner's `maxTokens` to the model's documented output limit (or 32,000, whichever is lower). Both are planner-call-only changes (not the shared `planner` policy row). Acceptance: ≥ 95% of planner calls over 48 h on staging answer from DeepSeek.
A2. Planner fallback = Bedrock Claude Opus 4.6, and visible (owner decision 2026-10-12: "planning is thinking, not coding"). The planner call passes an explicit fallback of `bedrock` / `eu.anthropic.claude-opus-4-6-v1` (the id already used as `PLAN_SPARRING_DEFAULT_MODEL`, `constants/llm-defaults.ts:115`) instead of inheriting the shared `planner` policy row's fallback (today Sonnet 4.6); the shared row is not changed (member-facing features read it). `callViaRouter` today takes the fallback only from the stage policy row (`llm-router.ts:1179-1189`); this phase adds a per-call `fallbackOverride {provider, model}` option to `callViaRouter` (rejected for `NO_FALLBACK_STAGES`; refuses `vertex`, `anthropic` and `claude_subscription`), and threads the same field through `runStageToolLoop` (`StageToolLoopOptions`, `StageLlmCall` and its `call()` closure, `llm-stage-tool-loop.ts:63-99,181-199`) in this same phase, so Phase B's tool loop keeps the Opus 4.6 fallback; a test proves a primary failure inside the loop is served by the override, not the policy row. Before the switch, a real `invoke-model` call proves the profile works on account 472838866351 / eu-central-1 (no Opus 4.6 call appears in 30 days of gateway telemetry; "ACTIVE" in the profile list is not proof, backend.md §2b). If it is denied, the phase stops and goes to the owner — no silent substitution with Sonnet or another model. Every plan version records `planner_provider`/`planner_model`; a `dev_autopilot.plan.fallback_used` OASIS event fires; the Command Hub autopilot screen shows the fallback rate. Sonnet stays the coding agent's model. No Google provider anywhere (unchanged).
A3. Real errors. `plan.failed` carries the router's actual error (no "unknown error" when the router returned one).
A4. Root-cause report for the 14 reverts, 6 failed, 5 escalated since 2026-09-18 and the 4 PRs stuck in `ci` (#4016–#4019): per execution, the failing stage and cause, committed as `docs/validation/<VTID-A>/outcome-analysis.md`. Each distinct cause gets a fix in this phase if it is in the autopilot pipeline itself; anything outside it is listed as a separate follow-up. The 4 stuck executions are closed out (the token's `pull_requests:write` on the repo is checked first; F7) (PR closed with a comment, execution marked failed with the reason) — no silent deletion.

## Phase B — the planner sees both repositories and the index (VTID B)
B1. Read-only planner tools in a multi-turn loop: the planner call moves from single-shot `callViaRouter` to the existing `runStageToolLoop` (`llm-stage-tool-loop.ts:157`, already used by the pre-merge review), with DeepSeek as primary and the Opus 4.6 fallback from A2. The tools reuse the plan-sparring partner's read-only GitHub tools (`plan-sparring/github-tools.ts`, repos `PLAN_SPARRING_REPOS`) plus the code index (`codeintel-index.ts`, `ALLOWED_CODE_INDEX_REPOS` = both repos): `read_file(repo, path, start_line?, end_line?)`, `search_code(repo, query)`, `list_dir(repo, path)`, `code_index(repo, target)` (callers, callees, tests for a file/symbol from the same index the coding agent pulls). `repo` is an allowlist of exactly `exafyltd/vitana-platform` and `exafyltd/vitana-v1`, read at `main`. Large files (e.g. `app.js`, 2.5 MB) are read by line range only.
B1a. Credential: the tools use the read-only `PLAN_SPARRING_GITHUB_TOKEN` (contents:read + metadata:read, both repos), never `GITHUB_SAFE_MERGE_TOKEN`. That secret is not wired into any gateway workflow today: creating the fine-grained token and the Secrets Manager entry is an owner step (no session has `secretsmanager:CreateSecret`); the workflow wiring follows only after the secret is confirmed to exist (backend.md §2c-fish ordering). Until then Phase B ships with tools disabled and the plan stays one-file (no failure).
B2. Bounded exploration (the 2026-04 Managed-Agents attempt timed out exploring): max 12 tool calls and 90 s wall time per plan, then the model must write the plan with what it has; the pre-fetched referenced file and schema context stay in the first prompt so a zero-tool plan is still grounded.
B3. Path validation: every path in "Files to modify" must exist at main or be explicitly marked new; a path in `deny_scope` or a non-existent directory fails the plan with a reason the planner gets back once (one revision round), then `plan.failed`.
B4. Scope: the planner READS both repos. Execution (clone, edit, PR) stays `vitana-platform`-only in this plan; a finding whose fix belongs in `vitana-v1` is planned and routed to the human queue with the plan attached. Cross-repo execution is a separate later plan.
B4a. Tool-call quality: the loop records parse failures and zero-tool plans per day; acceptance on staging = ≥ 80% of plans use at least one tool and < 5% tool-call parse failures over 48 h, else reported to the owner before Phase F.
B5. Code index for `vitana-v1`: if the index store has no `vitana-v1` bundle, `code_index` answers "not indexed" for that repo (no failure); building that index is listed as a follow-up, not done here.

## Phase C — no collisions with people (VTID C)
C1. Overlap check against every open PR in the repository (any author, any branch, drafts included), using each PR's file list from the GitHub API: (a) before claiming an execution, against the plan's file list; (b) before the auto-merge, against the PR's actual changed files. Overlap → execution status `held_overlap` with the blocking PR numbers; re-checked every watcher tick; released when the blocking PRs merge or close, then the autopilot PR is updated from main and re-validated before merge. No auto-merge on any timeout. A hold older than `overlap_hold_max_hours` (default 72) ends the execution as `failed` / `overlap_hold_timeout` (its PR closed with a comment) and the finding returns to the queue; the Command Hub autopilot screen lists held executions with their blocking PRs and a developer-role "release" action (which re-runs the overlap check, never skips it).
C2. `frozen_scope` (new `dev_autopilot_config` column, glob list, default `[]`). Difference from `deny_scope`: `deny_scope` is the permanent never-touch list checked when a plan is approved; `frozen_scope` is temporary, set while humans work an area, and is also checked at merge time for autopilot PRs that were already open when the freeze began: a plan touching a frozen path is never approved and an open autopilot PR touching one is never merged. Set via the existing config route (developer role) and shown on the Command Hub autopilot screen. Initial value at rollout: `services/gateway/src/frontend/command-hub/**` while the app.js split (VTID-05072/05073) is open.
C3. The pre-merge LLM review blocks the merge when the review call fails (fail closed), with one retry.
C4. Gate 2 clarity: the staging "ready for production" message lists autopilot commits (PR head `dev-autopilot/*` or `revert/auto-*`) in their own section.

## Phase D — governance: plans are sparred, approval is a recorded owner policy (VTID D)
D0. This phase changes the Autonomy Contract for the Dev Autopilot lane only: plans that converge in sparring and match an owner-signed policy no longer go to the owner one by one. Gate 1 for THIS plan is the owner's explicit decision on that change; without it Phase D ships D1/D3 only and every sparred plan still waits for human approval.
D1. Every autopilot plan goes through the existing plan-sparring service (partner: the configured `PLAN_SPARRING_MODEL`, Bedrock Claude, no fallback) before its VTID is allocated: DeepSeek plans, Claude spars, the planner (DeepSeek) answers the findings, up to 3 rounds. New code: a planner-response generator that gives the partner's findings to the DeepSeek planner (same tools/loop as B) and submits its answers and revised plan through `submitPlannerRound`; the sparring service itself is unchanged. Not converged → human queue with the full record. A failed partner call → human queue (never skipped).
D2. Owner standing approval as data: a new `dev_autopilot_approval_policy` row (scanner ids, risk classes, max effort, max files, approver identity, created_at, revoked_at) recorded by the owner's exafy_admin JWT through the existing approve path. A converged sparring record matching an active policy is approved by that policy (approval_evidence references the policy id). `human_approved_by` on the sparring record is the policy's approver (the owner identity verified from the JWT when the policy was created), and `approval_evidence` carries `{policy_id, plan_hash}`; the ledger trigger is unchanged. Revoking the policy stops further policy approvals immediately. No policy → human approval as today.
D3. VTID allocation passes the sparring id and plan hash, so the ledger trigger records it as sparred. Switching that trigger from log to enforce is NOT part of this plan.

## Phase E — limits (VTID E)
E1. Config defaults for the rollout: `daily_budget` 20, `concurrency_cap` 2, `cooldown_minutes` 10.
E2. Daily spend cap: `dev_autopilot_config.daily_spend_cap_usd` (default 25), summed per UTC day in the database (never in memory): agent runs already record usage and cost in `dev_autopilot_outcomes.metadata` (`recordAgentRunUsage`, `dev-autopilot-outcomes.ts:286`; summed by `summarizeSpendToday` behind `GET /dev-autopilot/spend`); planner and sparring calls get the same recording, priced with `estimateCost` (`constants/llm-defaults.ts` MODEL_COSTS); over the cap → no new claims or plans until 00:00 UTC, one OASIS event, Command Hub banner.

## Phase F — staged rollout (config changes, owner-visible, no new VTID)
F1. After A–E are in production: disarm the kill switch; auto-approve only through a policy for 2 low-risk scanners; `concurrency_cap` 1; per-diff human approval hold stays on; 48 h.
F2. Measure: plans written by DeepSeek ≥ 95%; landed (merged and verified on staging) ≥ 60% of approved executions; 0 reverts caused by overlap; 0 budget breaches. Report to the owner.
F3. If met: widen to the medium-risk scanners and `concurrency_cap` 2. Removing the per-diff human approval hold is a separate owner decision after 2 weeks meeting F2.
F4. Self-healing (`system_config.self_healing_enabled`) is turned on only at F3.

## Out of scope
Changing the planner's primary model; cross-repo execution in `vitana-v1`; building a `vitana-v1` code index; enforcing the ledger sparring trigger; production deploys by the autopilot; the older autopilot event loop / worker-runner path.

## Tests
A: unit tests for the planner call options and the fallback event; a regression test that an output-cap answer records the real error. B: tool allowlist (repo allowlist, read-only, line-range reads), exploration bounds, path validation incl. deny_scope. C: overlap hold/release against a fake GitHub (human PR overlapping, non-overlapping, closed), frozen_scope at approval and merge, review fail-closed. D: sparring-before-allocation, policy match/no-match, partner failure → human queue. E: budget and spend cap. Every phase keeps `npm run test:operator` and `test:support` green and adds these scenarios to `test/vtid-04465-operator-pipeline-regression.test.ts`: overlap hold entry and release; overlap hold timeout; frozen_scope rejection at approval; frozen_scope block at merge; spend cap blocking new claims; sparring-before-allocation; policy approval and policy revoked; pre-merge LLM review fail-closed. Staging read-only checks per phase in `docs/validation/<VTID>/staging-tests.json`.
<!-- plan:end -->

## Planner responses — round 1
- F1 blocker — ACCEPTED: B1 moves the planner to `runStageToolLoop` (multi-turn), with explicit max turns/tool calls/deadline.
- F2 major — ACCEPTED: A1 is now diagnose-then-fix with both branches defined; no "if supported" conditional in the implementation.
- F3 major — ACCEPTED: `overlap_hold_max_hours` (72) ends the execution and requeues the finding (never merges); held list + developer release action that re-runs the check.
- F4 major — ACCEPTED: D0 states the Autonomy Contract change and that it needs the owner's explicit yes at Gate 1; `human_approved_by` = the policy's verified approver, evidence = policy id + plan hash; trigger unchanged.
- F5 major — ACCEPTED: tools use `PLAN_SPARRING_GITHUB_TOKEN` (read-only). Verified it is not wired in any `.github/workflows/*.yml`, so provisioning is an owner step; B ships with tools off until the secret exists.
- F6 major — PARTLY REJECTED: cost recording exists for agent runs (`recordAgentRunUsage` dev-autopilot-outcomes.ts:286, `summarizeSpendToday`, `GET /dev-autopilot/spend` routes/dev-autopilot.ts:1442, `estimateCost`); ACCEPTED the gap: planner and sparring calls are added to the same DB recording; never in memory.
- F7 minor — ACCEPTED (A4).
- F8 minor — ACCEPTED: C2 states deny_scope vs frozen_scope.
- F9 minor — ACCEPTED: scenarios enumerated in Tests.
- F10 minor — ACCEPTED: D1 adds the DeepSeek planner-response generator.
- Owner amendment (2026-10-12) also in this round: planner fallback = Bedrock Opus 4.6 via a new per-call `fallbackOverride` on `callViaRouter` (no per-call fallback exists today, llm-router.ts:1179-1189); refused for NO_FALLBACK_STAGES; real invoke check first.
- Q1: answered by A1 step 1 (measured, not assumed). Q2: B4a measures tool-call quality with an acceptance bar. Q3: see F4. Q4: not wired in any workflow (see F5).

## Planner responses — round 2
- F12 major — ACCEPTED: A2 threads `fallbackOverride` through `StageToolLoopOptions`, `StageLlmCall` and the loop's `call()` in Phase A, with a test that a failed primary inside the loop is served by the override.
- F13 minor — ACCEPTED: `claude_subscription` is refused as a fallback override too.
- F14 minor — ACCEPTED (already added): "pre-merge LLM review fail-closed" is in the Tests scenarios.
- Q1: Phase A (the field exists wherever the override pattern exists; existing test seams get the optional field, no behaviour change).

## Sparring verdict
Round 1: 2 blockers, 5 majors, 4 minors (incl. owner amendment: Opus 4.6 planner fallback). Round 2: 1 major, 2 minors. Round 3: all 14 closed/acknowledged, no new findings. Verdict: CONVERGED (3 rounds, standard).


## Partner findings (verbatim)

### Partner pass 1

Now I have enough information for a comprehensive review. Let me compile my findings.

## Verified premises

- **Claim: `devPlannerModel()` = deepseek/deepseek-flash (`dev-pipeline-models.ts:27`)** -- TRUE. `DEV_PLANNER_DEFAULT` is `{ provider: 'deepseek', model: 'deepseek-flash' }` at `/home/user/vitana-platform/services/gateway/src/services/dev-pipeline-models.ts:27`.

- **Claim: planner called via `callViaRouter('planner', ..., {maxTokens: 8000, allowFallback: true})` (`dev-autopilot-planning.ts:180-183`)** -- TRUE. Confirmed at `/home/user/vitana-platform/services/gateway/src/services/dev-autopilot-planning.ts:180-183`.

- **Claim: planner context is one file fetched from `DEV_AUTOPILOT_REPO || 'exafyltd/vitana-platform'` via GitHub contents API, capped at 600,000 chars** -- TRUE. `GITHUB_REPO` at line 105, `FILE_MAX_CHARS = 600_000` at line 98 of `dev-autopilot-planning.ts`.

- **Claim: coding agent clones `exafyltd/vitana-platform` only (`:51-53`)** -- TRUE. `GITHUB_OWNER = 'exafyltd'`, `GITHUB_REPO = 'vitana-platform'` at `run-agent-execution.ts:51-52`.

- **Claim: the router already passes `tools` to DeepSeek** -- TRUE. `deepseekAdapter` at `llm-router.ts:825-833` maps tools into OpenAI function-calling format.

- **Claim: pr-clash gate is observe-only** -- TRUE. `pr-clash-gate.ts:4` says `JEV_PR_CLASH_MODE = off | shadow | enforce`; no enforcement; purely shadow/data-gathering per the header comment at lines 0-21.

- **Claim: the watcher only compares the PR with main (`dev-autopilot-watcher.ts:265-293`)** -- TRUE. `canMergeBehindWithoutUpdate` at lines 283-293 checks overlap between the PR's files and main's new commits, never against other open PRs (human or autopilot).

- **Claim: pre-merge LLM review lets the merge through when the review call fails** -- TRUE. `dev-autopilot-llm-review.ts:229`: `console.warn(... 'skipping review (fail-open)')` and returns `{ ok: false, passed: true, ... }`.

- **Claim: `vtid_ledger` sparring trigger is in log mode** -- TRUE. Migration `20261004110000_vtid_04868_plan_sparring_gate.sql` line 6: "It ships the gate in mode 'log': nothing is ever blocked".

- **Claim: VTID allocation for findings passes no sparring record** -- TRUE. `dev-autopilot-vtid-allocate.ts` has zero references to `sparring` or `p_sparring`.

- **Claim: `frozen_scope` and `daily_spend_cap_usd` do not exist on `dev_autopilot_config`** -- TRUE (they are new columns the plan proposes). The table definition at `20260416100000_dev_autopilot.sql:213-242` has no such columns. The config update route (`dev-autopilot-config-update.ts:16-26`) does not list them either.

- **Claim: code index supports both repos** -- TRUE. `codeintel-index.ts:43`: `ALLOWED_CODE_INDEX_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1']`.

- **Claim: plan sparring service already exists with `read_file`, `list_dir`, `search_code` tools and both-repo access** -- TRUE. `plan-sparring/github-tools.ts:21`: `PLAN_SPARRING_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1']`.

- **Verified facts 1, 2, 3** (kill_switch state, outcome counts from DB, planner call failure counts) -- CANNOT VERIFY against live database from this read-only code session. Accepting as stated.

## Findings

**F1 [blocker] The planner's `callViaRouter` is a single-shot call; Phase B's 12-tool-call loop requires a multi-turn loop that does not exist on the planner call path today.**

Evidence: `callViaRouter` at `llm-router.ts:1119` returns on the first model completion. When the model returns `tool_calls` instead of text, the caller gets `toolCall`/`toolCalls` fields but there is no loop to execute them and feed results back. Phase B proposes `read_file`, `search_code`, `list_dir`, `code_index` tools with "max 12 tool calls and 90s wall time" -- this requires building a multi-turn tool loop for the planner. The existing `runStageToolLoop` (`llm-stage-tool-loop.ts`) does this for the `validator` stage (used by `dev-autopilot-llm-review.ts:210`), but the plan does not acknowledge this prerequisite. The adapter passes tools through to DeepSeek (confirmed `llm-router.ts:825-833`), but consuming the tool call results requires the caller to implement the execute-and-re-call loop.

Suggestion: Explicitly state in Phase B that `callRoutedLlm` must be replaced with `runStageToolLoop` (or a similar multi-turn wrapper), not just "add tools to the DeepSeek call." The plan should reference the existing `llm-stage-tool-loop.ts` as the pattern to follow and note that the planner stage in `llm_routing_policy` may need its own tool-loop configuration (max turns, deadline, max tool calls).

**F2 [major] DeepSeek-V4.1-Flash thinking tokens: the plan does not validate whether the model supports `non-thinking mode` or whether the output cap issue is thinking tokens vs plan length.**

Evidence: The plan says (A1) "request non-thinking mode if the API supports it for this model." DeepSeek's reasoning models (R1, V3) do have thinking tokens, but DeepSeek-Flash models historically do NOT have thinking tokens -- their output tokens ARE the completion. The `stop_reason=length` with `output_tokens=8000` (premise 3) more likely means the plan text itself exceeds 8000 tokens, or the model is DeepSeek-R1 (a reasoning model, not Flash). The plan's fix ("non-thinking mode + raise maxTokens") conflates two different possible causes without investigating which one is real. If the model is truly `deepseek-flash` (a non-reasoning model), there is no "thinking mode" to disable, and the only fix is raising `maxTokens`.

Suggestion: Phase A1 should first verify which DeepSeek model is actually being invoked (the `deepseek-flash` model ID may map to a reasoning-capable model on DeepSeek's API), then choose the fix accordingly. If it is a reasoning model, request `reasoning_effort: 'low'` or disable chain-of-thought. If it is not, simply raise `maxTokens` to 16000 or 32000. The plan should not ship a "if the API supports it" conditional -- determine the answer before coding.

**F3 [major] Phase C overlap hold (`held_overlap`) has no timeout or starvation guard -- a long-lived human PR blocks the autopilot indefinitely.**

Evidence: The plan says (C1): "re-checked every watcher tick; released when the blocking PRs merge or close... No timeout auto-release." A human feature branch can stay open for weeks. During that time, every autopilot finding touching any of its files is permanently parked. With `concurrency_cap` 1-2 (Phase E), even one long-lived PR touching a common file like `index.ts` could halt the entire autopilot pipeline. The plan explicitly states "no timeout auto-release" -- this is a design choice, not an oversight, but it creates a liveness risk with no mitigation.

Suggestion: Add a configurable maximum hold duration (e.g., `overlap_hold_max_hours`, default 72h). After the hold expires, the execution transitions to `failed` with reason `overlap_hold_timeout` and the finding returns to the queue. Alternatively, add a Command Hub banner showing held executions and their blocking PRs, and give the developer a manual release button.

**F4 [major] Phase D's "approval policy" (`dev_autopilot_approval_policy`) bypasses the plan-sparring gate's human-approval requirement without explicitly addressing the governance implications.**

Evidence: CLAUDE.md Part 1 rule 51 says "Plan -> sparring -> owner approval -> VTID -> code." The sparring gate migration (`20261004110000_vtid_04868_plan_sparring_gate.sql:38-39`) requires `human_approved_by NOT NULL` for a valid VTID allocation. Phase D proposes that "a converged sparring record matching an active policy is approved by that policy" -- meaning the system would auto-approve plans without human review, effectively removing Gate 1 (the owner's explicit approval) for policy-matched findings. This is a deliberate governance relaxation. The plan says "no policy -> human approval as today" but does not address how auto-approval interacts with the existing `human_approved_by NOT NULL` constraint in the trigger, nor does it address CLAUDE.md's Autonomy Contract which states the owner is asked exactly two questions (Gate 1 and Gate 2).

Suggestion: State explicitly that the approval policy is an owner decision that MODIFIES the Autonomy Contract for the autopilot lane only, and explain how `human_approved_by` will be populated (policy-id as the approver? a system actor? NULL allowed for policy-approved plans?). The plan should also state that this requires an owner decision at Gate 1 specifically authorizing the relaxation, not just a config row.

**F5 [major] Phase B's planner tools use `GITHUB_SAFE_MERGE_TOKEN` (a write-capable token) rather than the read-only `PLAN_SPARRING_GITHUB_TOKEN`.**

Evidence: The planner's `fetchFileFromGitHub` at `dev-autopilot-planning.ts:203` uses `GITHUB_SAFE_MERGE_TOKEN || GITHUB_TOKEN`. The plan-sparring partner deliberately uses a separate `PLAN_SPARRING_GITHUB_TOKEN` ("a dedicated fine-grained token, contents:read + metadata:read, both repos. Deliberately never GITHUB_TOKEN or GITHUB_SAFE_MERGE_TOKEN: the partner must not hold a credential that can push/merge", per `github-tools.ts:11-12`). Phase B proposes adding read-only tools to the planner, but if it reuses the planner's existing token (`GITHUB_SAFE_MERGE_TOKEN`), those "read-only" tools hold a write-capable credential. If it uses `PLAN_SPARRING_GITHUB_TOKEN`, it needs to confirm that token exists on the deployed gateway task definition.

Suggestion: Phase B should explicitly state which token the planner's new tools will use. The plan-sparring partner's `PLAN_SPARRING_GITHUB_TOKEN` pattern (read-only, both repos) is the right credential. Verify it is provisioned in the ECS task definition. Do not reuse `GITHUB_SAFE_MERGE_TOKEN` for a read-only tool surface.

**F6 [major] Phase E's spend accounting ("summed per UTC day from recorded agent + planner + sparring usage") has no existing infrastructure to record costs per call.**

Evidence: The plan proposes `daily_spend_cap_usd` but does not describe where cost data is currently recorded or how it will be. The `callViaRouter` result includes `usage: { inputTokens, outputTokens }` but there is no existing cost-per-token lookup table or accumulated daily spend counter in the codebase. DeepSeek, Bedrock Claude, and the sparring partner all have different per-token pricing. The plan does not specify where the accumulation happens (in-memory counter that resets on deploy? database counter? OASIS events summed at query time?).

Suggestion: Specify the accumulation mechanism. An in-memory counter is the simplest but resets on deploy and does not work across multiple ECS tasks (`concurrency_cap` 2 means potentially 2 tasks). A database counter or OASIS event sum is more reliable. Also specify the cost model (which prices per provider/model, how often they are updated).

**F7 [minor] Phase A4 proposes closing out 4 stuck PRs (#4016-#4019) but the plan does not verify the autopilot's token can close PRs it did not open.**

Evidence: `GITHUB_SAFE_MERGE_TOKEN` is used for merge operations. The PRs were opened by the autopilot's own identity, so closing them should work, but the plan should confirm this rather than discovering a permissions issue at execution time.

Suggestion: Verify in Phase A4 implementation that the token has `pull_requests:write` scope for the repo.

**F8 [minor] Phase C proposes `frozen_scope` as a new `dev_autopilot_config` column but the existing `deny_scope` already blocks paths from execution.**

Evidence: `dev_autopilot_config.deny_scope` at `20260416100000_dev_autopilot.sql:233-240` already contains blocked paths. `frozen_scope` appears to overlap with `deny_scope`'s purpose. The distinction ("deny_scope blocks execution; frozen_scope blocks approval AND merge") is not stated in the plan.

Suggestion: Clarify the semantic difference between `frozen_scope` and `deny_scope` in the plan. If `deny_scope` already prevents a plan from being generated for those paths, `frozen_scope` is only needed for the pre-merge gate (blocking merge of an already-approved PR when a human PR subsequently lands on the same path). Make this explicit.

**F9 [minor] The plan does not mention adding the new execution states (`held_overlap`) and config fields (`frozen_scope`, `daily_spend_cap_usd`) to the operator pipeline regression test.**

Evidence: The plan's test section says "every phase keeps `npm run test:operator` green and adds scenarios to `test/vtid-04465-operator-pipeline-regression.test.ts`" -- good. But CLAUDE.md rule 42e says "IF you add a new operator behaviour (a new execution state, a new gate, a new hand-off) THEN add it as a scenario to the suite in the same PR." The plan should explicitly list which new scenarios are added for `held_overlap`, `frozen_scope`, and the spend cap gate.

Suggestion: In the test section, enumerate the specific new scenarios: (1) overlap hold entry/release, (2) frozen_scope rejection at approval, (3) frozen_scope rejection at merge, (4) spend cap gate blocking new claims, (5) sparring-before-allocation flow.

**F10 [minor] Phase D says "every autopilot plan goes through the existing plan-sparring service" but the sparring service's `callLlm` uses the Bedrock `plan_sparring` stage (no fallback), while the planner writes the plan on DeepSeek. The plan does not address whether DeepSeek can answer the partner's findings in the `submitPlannerRound` step.**

Evidence: `plan-sparring-service.ts` runs the partner on Bedrock Claude. The planner-responses step (round 2+) requires the planner (DeepSeek) to answer findings and revise the plan. The existing sparring service's `submitPlannerRound` accepts planner responses as text input from the caller -- it does not itself call DeepSeek. Phase D must wire the DeepSeek planner to generate responses to findings, which is new code not covered by the existing service.

Suggestion: Clarify that Phase D needs a new "planner response generator" that takes the partner's findings and asks the DeepSeek planner to respond. This is not just "wire autopilot plans through the existing service" -- it requires a new integration between the autopilot planner and the sparring service's round-trip protocol.

## Questions for the planner

1. Has the DeepSeek API's model catalog been checked to confirm what `deepseek-flash` actually resolves to? Is it a reasoning model (with thinking tokens) or a pure completion model? This determines whether Phase A1's "non-thinking mode" fix is even applicable.

2. For Phase B's tool calling: have you confirmed that DeepSeek-V4.1-Flash reliably produces well-formed tool calls in the OpenAI function-calling format? The router already parses them (`parseOpenAIToolCalls` at `llm-router.ts:865`), but some DeepSeek models have historically been unreliable at structured tool calling. If tool calls fail frequently, the "bounded exploration" fallback (zero-tool plan) will fire on most plans, defeating the purpose.

3. For Phase D: who is the `human_approved_by` for a policy-approved plan? The trigger checks `human_approved_by NOT NULL`. Does the policy approval set this to the policy creator's identity, or does Phase D require modifying the trigger?

4. Is the `PLAN_SPARRING_GITHUB_TOKEN` currently provisioned in the gateway ECS task definition, or only the plan-sparring sessions use it from Claude Code's own environment?

## Verdict

NOT CONVERGED

Open blockers: F1 (the plan assumes tool calling works through `callViaRouter` but that is single-shot; needs explicit acknowledgment of the multi-turn loop requirement).

Open majors: F2 (DeepSeek thinking tokens diagnosis is unvalidated), F3 (overlap hold starvation), F4 (approval policy vs governance gate conflict), F5 (token credential scope), F6 (spend accounting mechanism unspecified).

---

### Partner pass 2

Now I have a complete picture. Let me compile the full round-1 review incorporating the owner amendment about the explicit Opus 4.6 fallback.

## Verified premises

- **`devPlannerModel()` = deepseek/deepseek-flash** -- TRUE. `dev-pipeline-models.ts:27`: `DEV_PLANNER_DEFAULT = { provider: 'deepseek', model: 'deepseek-flash' }`.
- **Planner called via `callViaRouter('planner', ..., {maxTokens: 8000, allowFallback: true})` with `providerOverride`/`modelOverride`** -- TRUE. `dev-autopilot-planning.ts:180-187`.
- **Planner context is one file from `DEV_AUTOPILOT_REPO || 'exafyltd/vitana-platform'`, capped at 600k chars** -- TRUE. `dev-autopilot-planning.ts:98,105`.
- **Coding agent clones vitana-platform only** -- TRUE. `run-agent-execution.ts:51-52`.
- **DeepSeek adapter passes tools through** -- TRUE. `llm-router.ts:825-833`.
- **PR-clash gate is observe-only** -- TRUE. `pr-clash-gate.ts:1-21`, mode `off|shadow|enforce`, never enforces.
- **Watcher overlap check only against main, not other open PRs** -- TRUE. `dev-autopilot-watcher.ts:283-293`, `canMergeBehindWithoutUpdate` compares PR files with main's new commits only.
- **Pre-merge LLM review is fail-open** -- TRUE. `dev-autopilot-llm-review.ts:229`: returns `passed: true` on call failure.
- **Sparring trigger is log mode** -- TRUE. Migration `20261004110000_vtid_04868_plan_sparring_gate.sql:6`.
- **VTID allocation for findings passes no sparring record** -- TRUE. `dev-autopilot-vtid-allocate.ts` contains zero references to `sparring` or `p_sparring`.
- **`frozen_scope` and `daily_spend_cap_usd` are new columns** -- TRUE. Neither exists in `dev_autopilot_config` definition (`20260416100000_dev_autopilot.sql:213-242`) nor in subsequent ALTER migrations.
- **Code index supports both repos** -- TRUE. `codeintel-index.ts:43`: `ALLOWED_CODE_INDEX_REPOS = ['exafyltd/vitana-platform', 'exafyltd/vitana-v1']`.
- **`PLAN_SPARRING_DEFAULT_MODEL` = `eu.anthropic.claude-opus-4-6-v1`** -- TRUE. `constants/llm-defaults.ts:115`.
- **Verified facts 1, 2, 3** (live DB state, outcome counts, DeepSeek failure counts) -- CANNOT VERIFY from code alone; these reference production database state.

## Findings

**F1 [blocker] `callViaRouter` is single-shot; Phase B's 12-tool-call loop requires a multi-turn tool execution loop that does not exist on the planner call path.**

Evidence: `callViaRouter` at `llm-router.ts:1119-1199` makes one provider call and returns. When the model returns `tool_calls` instead of text, the caller receives `toolCall`/`toolCalls` fields but there is no mechanism to execute tools and feed results back for a follow-up call. Phase B proposes `read_file`, `search_code`, `list_dir`, `code_index` tools with "max 12 tool calls and 90s wall time" -- this requires a multi-turn tool loop. The existing `runStageToolLoop` in `llm-stage-tool-loop.ts` does exactly this for the `validator` stage (used at `dev-autopilot-llm-review.ts:210`), but the plan does not mention it. Currently `callRoutedLlm` at `dev-autopilot-planning.ts:171-198` calls `callViaRouter` directly, expecting text back.

Suggestion: Phase B must state that `callRoutedLlm` is replaced with a call to `runStageToolLoop` (from `llm-stage-tool-loop.ts`), passing the planner tools and an executor that calls the GitHub contents API / code index. This is the established pattern in this codebase. The tool executor should use `PLAN_SPARRING_GITHUB_TOKEN` (read-only, both repos) rather than `GITHUB_SAFE_MERGE_TOKEN`.

**F2 [blocker] `callViaRouter` does not support a per-call fallback override; Phase A2's explicit Opus 4.6 fallback requires a code change to the router or a workaround.**

Evidence: `LLMRouterOpts` at `llm-router.ts:126-140` has `providerOverride`/`modelOverride` which override the PRIMARY only (line 1140-1148: `stageConfig` spread replaces `primary_provider`/`primary_model`). The fallback is always read from the stage's `llm_routing_policy` row (lines 1175-1192: `stageConfig.fallback_provider`/`stageConfig.fallback_model`). The plan says (A2) "the planner call passes an explicit fallback of `bedrock` / `eu.anthropic.claude-opus-4-6-v1` instead of inheriting the shared `planner` policy row's fallback." There are three possible approaches:

(a) Add `fallbackProviderOverride`/`fallbackModelOverride` to `LLMRouterOpts` and wire them in `callViaRouter`. This touches the shared router contract.
(b) Handle the fallback at the caller level: if the `callViaRouter` primary (DeepSeek) fails, the caller itself makes a second explicit call with `providerOverride: 'bedrock'` / `modelOverride: 'eu.anthropic.claude-opus-4-6-v1'` and `allowFallback: false`. This avoids touching the router but means the fallback is outside the router's telemetry.
(c) If Phase B switches to `runStageToolLoop`, that wrapper delegates to `callViaRouter` per turn -- the same constraint applies there.

Additionally, the `planner` stage is NOT in `NO_FALLBACK_STAGES` (only `plan_sparring` is, `llm-defaults.ts:127`), so the Bedrock-only guard at line 1154 does not apply. No conflict with `NO_FALLBACK_STAGES` -- the planner stage can have any provider. But the router's policy-row fallback for `planner` is currently `deepseek/deepseek-flash` (`LLM_SAFE_DEFAULTS.planner` at `llm-defaults.ts:168-172`), not Opus. The plan says "the shared row is not changed" -- correct, but this means the router will use the policy row's fallback (Sonnet or DeepSeek depending on the live row), not Opus, unless the code is changed.

Suggestion: The plan must state which approach it takes. Option (b) is simplest and most consistent with "not touching the shared row": after `callViaRouter` with `allowFallback: false`, the caller itself calls `callViaRouter` again with `providerOverride: 'bedrock'` and `modelOverride: 'eu.anthropic.claude-opus-4-6-v1'`. Or option (a) if the planner adds `fallbackProviderOverride`/`fallbackModelOverride` to `LLMRouterOpts`. Either way, specify.

**F3 [major] DeepSeek-V4.1-Flash "thinking tokens" diagnosis is unvalidated; the fix may not match the cause.**

Evidence: Phase A1 says "reasoning/thinking tokens counted against the cap, or plan length" and proposes "request non-thinking mode if the API supports it." DeepSeek-V4.1-Flash (`deepseek-flash`) may or may not have a thinking/reasoning mode. The `llm-defaults.ts:162-166` comment says: "There is no separate reasoning-mode model id to preserve the old chat/reasoner cost split with." This suggests the flash model does NOT have a thinking mode -- it is a single-mode model. If so, the `stop_reason=length` with `output_tokens=8000` simply means the plan text itself exceeds 8000 tokens, and the only fix is raising `maxTokens`. The plan hedges with "if the API supports it" but should determine the answer first. Shipping code that tries to disable a nonexistent mode wastes a phase.

Suggestion: Before coding Phase A1, check the DeepSeek API docs (or make one test call with `output_tokens=16000`) to determine whether `deepseek-flash` has thinking tokens. If it does, disable them and raise the cap. If it does not, just raise `maxTokens` to 16000 or the model's maximum. State the finding in the plan so Phase A1's implementation is clear.

**F4 [major] Phase C overlap hold (`held_overlap`) has no timeout or starvation guard.**

Evidence: The plan (C1) says "No timeout auto-release." A human feature branch touching `index.ts` (a god-node file in this repo, per the code health data) can stay open for weeks. During that time, every autopilot finding touching any of its files is permanently parked at `held_overlap`. With `concurrency_cap` 1-2, even one such PR halts the pipeline. The plan's "0 reverts caused by overlap" success metric (F2) is trivially satisfied if the autopilot never runs.

Suggestion: Add a configurable maximum hold duration (e.g., `overlap_hold_max_hours`, default 72h or configurable in `dev_autopilot_config`). After the hold expires, the execution transitions to `failed` with `overlap_hold_timeout` and the finding returns to the queue. Alternatively, add the held executions and their blocking PRs to the Command Hub autopilot screen, with a manual release option.

**F5 [major] Phase D's approval policy auto-approves plans, bypassing the sparring gate's `human_approved_by NOT NULL` constraint.**

Evidence: The sparring trigger at `20261004110000_vtid_04868_plan_sparring_gate.sql:38-39` requires `human_approved_by NOT NULL` for a `valid` outcome. Phase D says "a converged sparring record matching an active policy is approved by that policy (approval_evidence references the policy id)." This means either: (a) the autopilot must call `POST /:id/approve` with a system actor, which requires `requireAdminAuth` (`plans-spar.ts:9`), or (b) the trigger must be modified to accept policy-approved records without `human_approved_by`. Neither is mentioned. The Autonomy Contract (CLAUDE.md) says the owner is asked exactly two questions -- Gate 1 and Gate 2. Phase D removes Gate 1 for policy-matched findings without acknowledging this as a governance change.

Suggestion: State explicitly that: (1) the approval policy is an owner decision that modifies the Autonomy Contract for the autopilot lane specifically, (2) explain how `human_approved_by` is populated (the policy creator's identity? a new `policy_approved_by` field? a trigger change?), and (3) require the owner to explicitly approve this governance relaxation at Gate 1 for Phase D specifically.

**F6 [major] Phase B's planner tools would hold a write-capable credential unless explicitly using `PLAN_SPARRING_GITHUB_TOKEN`.**

Evidence: The planner's `fetchFileFromGitHub` at `dev-autopilot-planning.ts:203` uses `GITHUB_SAFE_MERGE_TOKEN || GITHUB_TOKEN`. The plan-sparring service deliberately uses a separate read-only `PLAN_SPARRING_GITHUB_TOKEN` (`github-tools.ts:11-12`: "a dedicated fine-grained token, contents:read + metadata:read, both repos. Deliberately never GITHUB_TOKEN or GITHUB_SAFE_MERGE_TOKEN: the partner must not hold a credential that can push/merge"). Phase B adds tools that should be read-only. If they inherit the planner's `GITHUB_SAFE_MERGE_TOKEN`, the "read-only" tools hold a write-capable credential for the planner LLM to use (DeepSeek, an external model).

Suggestion: Phase B should use `PLAN_SPARRING_GITHUB_TOKEN` for the planner's new tools, following the same security principle the sparring partner already follows. This also gives both-repo read access, which the planner needs. Verify `PLAN_SPARRING_GITHUB_TOKEN` is provisioned in the ECS task definition.

**F7 [major] Phase E's spend accounting has no existing infrastructure and no specified accumulation mechanism.**

Evidence: The plan proposes `daily_spend_cap_usd` "summed per UTC day from recorded agent + planner + sparring usage" but does not specify where cost data is recorded or accumulated. `callViaRouter` returns `usage: { inputTokens, outputTokens }` but there is no cost lookup or daily counter anywhere in the autopilot code today. `MODEL_COSTS` exists in `llm-defaults.ts:245-269` but is not used by the planner call path. With `concurrency_cap` 2 and ECS potentially running multiple tasks, an in-memory counter is insufficient.

Suggestion: Specify the accumulation mechanism in the plan. Options: (a) write each call's cost to a `dev_autopilot_spend` table and sum at claim time, (b) use an OASIS event query, or (c) use the existing `MODEL_COSTS` table in `llm-defaults.ts` and an in-memory counter with a database-backed reset. State the choice and its accuracy bounds.

**F8 [minor] The plan proposes `frozen_scope` but `deny_scope` already exists and their semantic difference is not stated.**

Evidence: `dev_autopilot_config.deny_scope` at `20260416100000_dev_autopilot.sql:233-240` blocks paths from being planned/executed. Phase C adds `frozen_scope` which "a plan touching a frozen path is never approved and an open autopilot PR touching one is never merged." The distinction between "deny_scope" (permanent, security-sensitive paths) and "frozen_scope" (temporary, active-work paths) is not stated in the plan.

Suggestion: Add one sentence explaining: `deny_scope` permanently blocks security-sensitive paths from autonomous execution; `frozen_scope` is a temporary hold on paths where concurrent human work is underway, set and cleared by developers via the Command Hub.

**F9 [minor] Phase B's `code_index` tool for `vitana-v1` depends on the index being built by `CODEINTEL-INDEX.yml`, which may not include `vitana-v1` today.**

Evidence: `codeintel-index.ts:43` lists both repos in `ALLOWED_CODE_INDEX_REPOS`, but the plan says (B5) "if the index store has no `vitana-v1` bundle, `code_index` answers 'not indexed'." The plan correctly handles this case. However, building the `vitana-v1` index is listed as "out of scope" -- the planner will have `read_file`/`search_code`/`list_dir` for `vitana-v1` but NOT `code_index`, which limits its value for that repo.

Suggestion: Acceptable as-is if the plan acknowledges this gap explicitly. The `read_file`/`search_code`/`list_dir` tools via the GitHub API are sufficient for basic cross-repo planning. A follow-up VTID for the `vitana-v1` code index is already noted.

**F10 [minor] Phase D's planner-responds-to-findings step requires new integration code not described.**

Evidence: The existing sparring service (`plan-sparring-service.ts`) accepts planner responses as input from the caller (`submitPlannerRound` at `plans-spar.ts:55-58`). Phase D says "the planner (DeepSeek) answers the findings" -- this requires a new code path that takes the partner's findings, asks the DeepSeek planner to generate responses, and submits them back to the sparring service. This is distinct from the existing service and from the existing planner call.

Suggestion: Note in Phase D that a new `generatePlannerResponseToFindings` function is needed that: (a) takes the partner's findings as input, (b) calls the DeepSeek planner via `callViaRouter`/`runStageToolLoop` to generate responses, and (c) calls `submitPlannerRound` with the results.

**F11 [minor] Test section does not enumerate the specific new scenarios for the operator pipeline regression test.**

Evidence: CLAUDE.md rule 42e: "IF you add a new operator behaviour (a new execution state, a new gate, a new hand-off) THEN add it as a scenario to the suite in the same PR." The plan says "adds scenarios to `test/vtid-04465-operator-pipeline-regression.test.ts`" but does not list which scenarios.

Suggestion: Enumerate: (1) `held_overlap` entry and release, (2) `frozen_scope` rejection at approval and at merge, (3) spend cap gate, (4) sparring-before-allocation, (5) LLM review fail-closed (Phase C change from the current fail-open).

## Questions for the planner

1. For the owner amendment (A2 explicit Opus 4.6 fallback): which approach will you use given that `callViaRouter` supports only primary overrides, not fallback overrides? Caller-level two-call pattern, or adding `fallbackProviderOverride`/`fallbackModelOverride` to `LLMRouterOpts`?

2. Has the DeepSeek API been checked to confirm whether `deepseek-flash` (DeepSeek-V4.1-Flash) has thinking/reasoning tokens? The `llm-defaults.ts:165` comment ("There is no separate reasoning-mode model id") suggests it does not. If so, Phase A1 simplifies to just raising `maxTokens`.

3. For Phase D: how does the approval policy satisfy the `human_approved_by NOT NULL` constraint in the sparring trigger? Does the system auto-call `POST /:id/approve` with the policy creator's identity, or does the trigger need modification?

4. Is `PLAN_SPARRING_GITHUB_TOKEN` currently provisioned in the gateway ECS task definition (staging and production), or only used by Claude Code sessions?

5. For Phase B: have you observed DeepSeek-V4.1-Flash producing reliable tool calls in the OpenAI function-calling format? If the tool-call success rate is low, the "bounded exploration" fallback (zero-tool plan) will fire on most plans, defeating the purpose.

## Verdict

NOT CONVERGED

Open blockers: F1 (multi-turn tool loop missing from plan -- the mechanism exists in the codebase but the plan does not reference it), F2 (per-call fallback override not supported by `callViaRouter` -- the plan needs to specify how the explicit Opus 4.6 fallback is wired).

Open majors: F3 (thinking token diagnosis unvalidated), F4 (overlap hold starvation), F5 (approval policy vs sparring trigger `human_approved_by`), F6 (token credential scope for planner tools), F7 (spend accounting mechanism).

---

### Partner pass 3

Good. The `fallbackUsed` flag on `LLMRouterResult` (line 215) already records whether the fallback was used, and `runStageToolLoop` passes it through (line 199). The telemetry path looks clean.

Now I have everything I need for the round-2 review.

## Verified premises

- **`recordAgentRunUsage` exists at `dev-autopilot-outcomes.ts:286`** -- TRUE. Confirmed: records per-run usage and cost to `dev_autopilot_outcomes.metadata.agent_runs[]`.
- **`summarizeSpendToday` exists at `dev-autopilot-outcomes.ts:253`** -- TRUE. Confirmed: pure function summing `agent_runs[]` entries by UTC date.
- **`GET /dev-autopilot/spend` exists at `routes/dev-autopilot.ts:1442`** -- TRUE. Confirmed: `router.get('/spend', requireDevRole, ...)`.
- **`estimateCost` exists at `constants/llm-defaults.ts:304`** -- TRUE. Confirmed: uses `MODEL_COSTS` lookup table with per-model input/output rates.
- **`runStageToolLoop` at `llm-stage-tool-loop.ts:157`** -- TRUE. Confirmed: multi-turn tool loop used by the LLM review, with `providerOverride`/`modelOverride` pass-through.

## Findings — prior round status

- **F1 (blocker, tool loop)** -- `closed`. B1 now explicitly uses `runStageToolLoop` from `llm-stage-tool-loop.ts:157`, with the planner tools and bounded exploration. The pattern matches the existing pre-merge review usage.

- **F2 (blocker, per-call fallback override)** -- `closed`. A2 now specifies adding `fallbackOverride {provider, model}` to `callViaRouter`, refused for `NO_FALLBACK_STAGES` and for `vertex`/`anthropic`. See new finding F12 for one remaining threading issue.

- **F3 (major, thinking tokens diagnosis)** -- `closed`. A1 is now diagnose-first (20 calls, log raw `usage` including `reasoning_tokens` and `reasoning_content`), then one fix by evidence. No speculative code.

- **F4 (major, overlap hold starvation)** -- `closed`. C1 now has `overlap_hold_max_hours` (default 72), execution fails as `overlap_hold_timeout`, finding requeued, Command Hub shows held executions with a developer release action that re-runs the check.

- **F5 (major, approval policy vs sparring trigger)** -- `closed`. D0 explicitly states this is an Autonomy Contract change needing the owner's explicit yes at Gate 1. D2 specifies `human_approved_by` is the policy's approver identity (verified from the JWT at policy creation), `approval_evidence` carries `{policy_id, plan_hash}`, trigger unchanged. This is coherent with the trigger's `human_approved_by NOT NULL` check.

- **F6 (major, token credential scope)** -- `closed`. B1a specifies `PLAN_SPARRING_GITHUB_TOKEN` (read-only, both repos), acknowledges it is not wired in any workflow, and ships tools-off until the secret exists.

- **F7 (major, spend accounting)** -- `acknowledged`. The planner's partial rejection is valid: `recordAgentRunUsage` (`dev-autopilot-outcomes.ts:286`), `summarizeSpendToday` (`:253`), `estimateCost` (`llm-defaults.ts:304`), and `GET /spend` (`routes/dev-autopilot.ts:1442`) all exist and work for agent runs today. The gap (planner and sparring calls not yet recording into the same infrastructure) is acknowledged and E2 says they will be added using the same DB recording. The mechanism is database-backed, not in-memory, which handles multi-task correctness. Accepted.

- **F8 (minor, frozen_scope vs deny_scope)** -- `closed`. C2 now states the semantic difference.

- **F9 (minor, vitana-v1 code index)** -- `closed`. B5 correctly handles the missing bundle case and the follow-up is listed out of scope.

- **F10 (minor, planner-response generator)** -- `closed`. D1 now explicitly calls out the new planner-response generator that feeds the DeepSeek planner the partner's findings and submits through `submitPlannerRound`.

- **F11 (minor, test scenarios)** -- `closed`. The Tests section now enumerates specific scenarios: overlap hold entry/release, overlap hold timeout, frozen_scope rejection at approval and merge, spend cap blocking new claims, sparring-before-allocation, policy approval and policy revoked.

## New findings

**F12 [major] The `fallbackOverride` must be threaded through `StageToolLoopOptions`, `StageLlmCall`, and the `call()` closure in `runStageToolLoop` -- or Phase B's tool-loop planner will silently lose the Opus 4.6 fallback.**

Evidence: `StageToolLoopOptions` at `llm-stage-tool-loop.ts:79-99` passes `providerOverride`/`modelOverride` through (lines 92-93), and the `call()` closure at lines 192-193 spreads them into the `callLlm` invocation. But there is no `fallbackOverride` field on `StageToolLoopOptions` or on `StageLlmCall` (lines 63-77). When Phase A adds `fallbackOverride` to `LLMRouterOpts` and Phase B switches the planner to `runStageToolLoop`, the fallback override will not be passed through unless `StageToolLoopOptions` and `StageLlmCall` are also updated. The planner would silently fall back to whatever the shared `planner` policy row says (Sonnet, not Opus), defeating A2's intent.

Suggestion: Phase A's `fallbackOverride` implementation must also add the field to `StageToolLoopOptions` and `StageLlmCall`, and thread it through `call()` at line 194. This is a small change (3 additions parallel to the existing `providerOverride`/`modelOverride` pattern) but must be called out in the plan so Phase B does not discover it.

**F13 [minor] The `fallbackOverride` validation ("refusing vertex/anthropic like dev-pipeline-models.ts") should also refuse `claude_subscription` -- a per-call fallback to the free `claude -p` wrapper is nonsensical for the planner and would fail differently from any other provider.**

Evidence: `dev-pipeline-models.ts:30` refuses only `vertex` and `anthropic` (`REFUSED_PROVIDERS`). `claude_subscription` (lines 891-920 of `llm-router.ts`) is a pseudo-provider that routes through the local autopilot-worker queue. It is not a real model provider. A `fallbackOverride` pointing at it would attempt to route the planner fallback through a worker subprocess running `claude -p`, which is structurally wrong for a headless LLM call.

Suggestion: Add `claude_subscription` to the refused set for `fallbackOverride` validation. This is minor because no caller would plausibly set it, but defense-in-depth is the stated posture.

**F14 [minor] The plan does not mention adding the "LLM review fail-closed" scenario to the operator pipeline regression test.**

Evidence: Phase C3 changes the LLM review from fail-open to fail-closed with one retry. The test section lists seven specific scenarios but does not include "LLM review call fails -> merge blocked (with retry)." CLAUDE.md rule 42e requires new operator behaviours to be added as scenarios.

Suggestion: Add "LLM review fail-closed with retry" to the enumerated test scenarios in the Tests section.

## Questions for the planner

1. The `StageLlmCall` type at `llm-stage-tool-loop.ts:63-77` is used by test seams in the LLM review and other callers. Changing it adds the `fallbackOverride` field to every test that injects a custom `callLlm`. Is this acceptable as a Phase A scope item, or should it be deferred to Phase B when the planner actually uses the loop? (The answer is probably "Phase A, since the field should exist everywhere the override pattern exists," but confirm.)

## Verdict

NOT CONVERGED

One open major: F12 (fallbackOverride must be threaded through `StageToolLoopOptions`/`StageLlmCall` or the tool loop silently drops it). Two open minors (F13, F14) that do not block convergence on their own but should be addressed.

---

### Partner pass 4

The plan is updated. Let me verify the test scenarios include the LLM review fail-closed item that F14 flagged.

The Tests section (line 63) now ends with "pre-merge LLM review fail-closed" in the enumerated scenarios. All three round-2 findings are addressed in the plan body and the planner responses.

## Verified premises

All premises verified in rounds 1 and 2 remain valid. No new factual claims to verify.

## Findings -- prior round status

**Round 1 findings (all previously closed in round 2, unchanged):**
- F1 (blocker, tool loop) -- `closed`
- F2 (blocker, per-call fallback override) -- `closed`
- F3 (major, thinking tokens diagnosis) -- `closed`
- F4 (major, overlap hold starvation) -- `closed`
- F5 (major, approval policy vs sparring trigger) -- `closed`
- F6 (major, token credential scope) -- `closed`
- F7 (major, spend accounting) -- `acknowledged`

**Round 1 minors (all previously closed in round 2, unchanged):**
- F8 (frozen_scope vs deny_scope) -- `closed`
- F9 (vitana-v1 code index) -- `closed`
- F10 (planner-response generator) -- `closed`
- F11 (test scenarios) -- `closed`

**Round 2 findings:**
- F12 (major, fallbackOverride threading through StageToolLoopOptions/StageLlmCall) -- `closed`. A2 now explicitly states "threads the same field through `runStageToolLoop` (`StageToolLoopOptions`, `StageLlmCall` and its `call()` closure, `llm-stage-tool-loop.ts:63-99,181-199`) in this same phase" with a test that a failed primary inside the loop is served by the override. The file and line references are correct.
- F13 (minor, claude_subscription refused) -- `closed`. A2 now lists `claude_subscription` alongside `vertex` and `anthropic` in the refused set.
- F14 (minor, LLM review fail-closed test scenario) -- `closed`. "pre-merge LLM review fail-closed" appears in the Tests section's enumerated scenarios.

## New findings

None. The plan addresses every blocker and major from rounds 1 and 2. The design is internally consistent: Phase A adds the router and loop infrastructure, Phase B uses it for multi-turn planning, Phase C adds collision guards, Phase D adds governance, Phase E adds spend limits, Phase F is a staged rollout. Each phase is its own VTID and PR. The test plan is concrete and covers the operator pipeline regression suite. No CLAUDE.md rule is violated (Claude via Bedrock for the coding agent and sparring partner, no Google fallback, staging-first deployment, no production writes from the autopilot, plan sparring gate for governance).

## Questions for the planner

None remaining.

## Verdict

CONVERGED

No open blocker or major findings. All 14 findings from rounds 1 and 2 are closed or acknowledged with satisfactory responses. The plan is ready for Gate 1.