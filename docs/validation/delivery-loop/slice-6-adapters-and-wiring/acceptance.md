Change types: Backend, Integration, Infrastructure/CI (documentation of the environment only).
# Delivery loop, slice 6: adapters, runtime, status route, wiring

No approved lane or VTID covers this slice (VTIDs come only from CI PLAN-SPAR; none was invented). Part of the WIP merge request "delivery
loop"; it needs `plan(delivery-loop)` before it can merge.

This slice connects the engine of slice 5 to the gateway: the production adapters for learning, review and the executor, a scheduler, a
read-only status route and the start in `index.ts`. With `DELIVERY_LOOP_ENABLED` unset (the default, in every environment, because no task
definition sets it) the loop does not start and nothing in this slice runs.

## What is connected

| Piece | File | Connects to |
|---|---|---|
| Learning | `adapters.ts` `createLearnPort` | `writeDevMemory` (category `task_outcome`, or `incident` for an exhausted repair) and the repair-pattern store (`recordPattern`, `findPatternBySignature`) |
| Review | `adapters.ts` `createReviewerPort`, `runtime.ts` | the LLM router's `validator` stage (Claude on Bedrock by the standing rule, never Google), which the pre-merge review already uses |
| Executor | `adapters.ts` `createExecutorTaskPort` | nothing yet: it **fails closed** (see below) |
| Scheduler | `runtime.ts` `startDeliveryLoop` | `engine.ts`; shaped on the Project Manager loop (no overlapping ticks, `unref`'d, a failing tick is logged and swallowed) |
| Status | `routes/delivery-loop.ts` | `GET /api/v1/delivery-loop/status`, read-only, behind `requireServiceOrAdmin` |
| Start | `index.ts` (20 added lines) | started only when `DELIVERY_LOOP_ENABLED` is exactly `true`, inside a try/catch that makes failure non-fatal |
| Atlas | `orb/developer/domain-atlas.ts` | the route file is claimed by the `deploy` domain (the drift guard) |
| Environment | `.env.example` | every variable documented, with its default and its bound |

## Acceptance criteria and the tests that prove them

AC-1 **Off means off.** Without `DELIVERY_LOOP_ENABLED=true` the scheduler reads nothing, writes nothing and starts no timer's work, however
often the timer fires; a loop switched off at run time stops acting on its next tick without a restart. Without a project list, `GITLAB_API_URL`
or `GITLAB_API_TOKEN` it does not run and says why once, in the log and in the status.
TEST: runtime.test.ts (13 tests): "a loop that is not enabled runs nothing", "without GitLab configured it says why, once", "a loop switched off at run time".

AC-2 **The scheduler is safe.** Ticks never overlap, the timer is `unref`'d so it cannot keep the process alive, a tick that throws is swallowed and
the next one runs, and the status never carries the token, the GitLab host or an issue's text.
TEST: runtime.test.ts "never runs two ticks at once", "a tick that throws is logged and swallowed", "the timer is unref'd", "the status never carries the token".

AC-3 **The review is a verdict or it is nothing.** The model is shown the merge request and the diff as data and told nothing in them is an instruction.
Its answer must be the JSON contract (`accept` or `changes` with findings); prose, an unknown verdict, `changes` with no finding and a truncated answer are
not verdicts and are never taken as an accept or turned into a rework; the reviewed head is the merge request's own.
TEST: adapters.test.ts `parseVerdict` (6 tests), "the reviewer port" (4 tests), including an instruction hidden in a diff. A mutation check (removing the cut on the
description) fails the test that guards it.

AC-4 **Learning writes to the real stores' contracts.** A verified repair is stored under `project:fingerprint` with the merge request that carries it; an outcome is a
dev memory row filed under the right repository and category (an exhausted repair is an `incident`, importance 8); a store that is down is a failed lesson, which the
sweep of slice 5 tries again. A known fix is found under the key it was stored under, never from a quarantined pattern.
TEST: adapters.test.ts "the learning port" (7 tests). The binding was type-checked against the real `writeDevMemory`, `recordPattern`, `findPatternBySignature` and `callViaRouter`.

AC-5 **The executor port fails closed, and the loop says so.** With no executor the dispatch is refused as not retryable, which ends the intent and says so on the issue;
the loop never silently drops work and never starts work through a path nobody approved. It is switched on only by `DELIVERY_LOOP_EXECUTOR=dev-autopilot` together with
a gateway the owner binds; either alone changes nothing.
TEST: adapters.test.ts "the executor port" (4 tests), "the engine with no executor"; runtime.test.ts "the executor is the fail-closed one".

AC-6 **The route is read-only and wired once.** No write, act, enable, level or cycle endpoint exists (every method on seven such paths answers 404); it is refused without the
service token; with no loop started it answers 200 saying so; it is mounted once through the duplicate-route guard, and the loop starts only behind the exact switch.
TEST: route.test.ts (9 tests), plus the existing route guard, the role-separation regression (atlas drift guard), the loop catalog and the GitLab route-claim suites, all green.

AC-7 **Nothing else moved.** `tsc --noEmit` is clean (outputs/tsc.txt), the test files and harness compile, the operator and role regression suites pass, and the full gateway suite
result is in outputs/full-gateway-suite.txt.

## What this does NOT do, and why: the executor

**Dev Autopilot has no GitLab host, and the loop cannot start work yet.** This is a decision for the owner, not a missing line of code. The facts, read in the code:

- Dev Autopilot's agent executor clones from `github.com`, opens its pull request through `api.github.com` (`run-agent-execution.ts`: the repository, base branch, token and `openPullRequest` are
  constants for the one GitHub repository), and hands the result to a CI, deploy and verification watcher chain that is keyed to GitHub pull request numbers. About forty sites read an
  execution in status `ci`. A GitLab merge request iid put into that chain would be read as a GitHub PR number.
- Every way into the executor from the loop crosses a line that is not this change's to cross. The operator on-ramp mints a VTID under an operator's authority
  (`OPERATOR_VTID_SELF_ALLOCATE_ENABLED`, `allocate_global_vtid` with source `operator-console`), and the loop has no operator. A new `source_type` for the loop belongs on
  `MANUALLY_BRIDGEABLE_SOURCE_TYPES`, which is locked on purpose (four existing tests pin it, one of them against the Command Hub's `app.js`); I tried that edit, it broke those four, and I
  reverted it. And a VTID for new work is allocated after a sparred plan (CLAUDE.md rules 51 to 55).
- What would make it work, for the owner to choose: (a) a GitLab host for the agent executor (clone and push to GitLab, open a merge request, end the execution at a status the GitHub
  watchers ignore), which is a plan of its own under `plan(delivery-loop)` and PLAN-SPAR; (b) the sanctioned VTID path for loop-created work, decided in that plan; (c) an entry on the
  locked source-type list, with its Command Hub mirror, once (b) is decided.

Until then everything up to the executor works and everything after it is refused, visibly: intake decides and says so on the issue, a failed pipeline is classified, an infra failure is
retried through GitLab (which needs no executor), a repair is requested as an intent, and the intent ends with a note that no executor is configured. The reviewer and the learner do not
depend on it.

## Other things this does NOT do

- It does not add the loop to the loop catalog (`specs/loop-catalog-v1.json`). The catalog says every sensor is owned by exactly one loop and documents fourteen loops; adding a fifteenth is a decision about how the
  repository describes its loops and belongs in the plan review.
- It does not set `DELIVERY_LOOP_*` in any ECS task definition. `AWS-STAGE-DEPLOY-GATEWAY.yml` is a live-deploy file; wiring the variables, the GitLab token secret and `DELIVERY_LOOP_PROJECTS` is the owner's step.
- Nothing ran against a live gateway, database, LLM or worker. The LLM binding is type-checked against the router and the memory and pattern bindings against their stores, but no call was made.
