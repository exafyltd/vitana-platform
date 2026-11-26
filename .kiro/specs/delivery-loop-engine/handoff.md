---
slug: delivery-loop-engine
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-20T00:36Z
---
# Handoff — delivery-loop-engine

Plan: `plan.md`. Tasks: `tasks.md`. Five lanes (`lanes/*.md`). Registration is blocked: `registration-blocked.md`.

## Log

### 2026-11-19T19:50Z · kiro-exafyltd-202611181014-b8e5 · drafted
The `plan(delivery-loop)` of GitLab MR !79 (slug `delivery-loop-engine`: a branch `kiro/delivery-loop` exists, so `kiro/delivery-loop/<lane>`
cannot). Pushed as a `plan(` PR for PLAN-SPAR. No VTID before convergence; CI allocates them.

PLAN-SPAR cannot run for any plan: the gateway it calls answers 401 since 2026-11-18 22:23 UTC. The contract, the evidence and the
minimal admin fix are in `registration-blocked.md`; they match the preview-gateway-recovery plan (#5122, KIRO 12), which already
holds the fix and waits on the owner's Rule 55 ruling. Nothing here duplicates it.

All lane code and tests exist on `kiro/delivery-loop-engine/combined` (draft PR #5126, no VTID; it replaces #5124, which GitHub closed when the branch was renamed from `…/gitlab-executor` on 2026-11-20). Once VTIDs exist, each lane is cut
from it into its own branch from `origin/main`.

Coordination: Kiro 5's autopilot GitLab port plan (GitLab MR !1, closed draft, items P2, P3, P16, P23) covers a full GitHub-to-GitLab
switch of Dev Autopilot. The `gitlab-executor` lane is the narrow part it needs first (one repair path, P16's clone form, P23's GitLab
double in the operator suite) and does not build P2's `SCM_PROVIDER` switch. Kiro 4 and Kiro 5 are named on the plan PR.

Next: the owner's ruling on #5122 (or another sparring path); then PLAN-SPAR spars this PR, policy approval allocates the VTIDs, and
the driver cuts the lanes.

### 2026-11-20T00:36Z · kiro-exafyltd-202611181014-b8e5 · drafted (owner decision D1/D2, lanes separated)
Owner, 2026-11-19: the narrow PLAN-SPAR correction of #5122 is authorized (preview only): the preview gateway consumes
`vitana/gateway/staging/preview-sparring-token`, a dedicated `PLAN_SPAR_GATEWAY_TOKEN`, the protected workflow only through governance
and reviewer accepts, the shared `GATEWAY_SERVICE_TOKEN` unchanged, allocation off on the preview. The admin steps (bind the token as
`vitana-gateway-preview:3`; set the GitHub secret; optionally `PLAN_SPAR_ALLOCATE=false`) are on #5122 (comment 7025860613), with the
read-only checks behind them. Kiro does not run them: they are live writes and repository secrets (§7a, §7d "Never").

Still needed before PLAN-SPAR can spar this PR: the plan-spar-token lane of #5122 on `main`. That needs a rule 55 break-glass VTID
(owner) and two reviewer-agent accepts from different chain models. After that, a new commit here (a re-run keeps the old base
workflow). Under D2 a preview run allocates nothing, so the five VTIDs then need the ledger owner's canonical allocation.

Lane separation of #5124: five stacked branches `kiro/delivery-loop-engine/<lane>`, each with only its lane's paths (see each lane's
log). Two cross-lane imports were fixed on the combined branch first: `ExecutorGateway` moved to `ports.ts` (plan §5), and the
executor-switch test moved to `adapters.test.ts`. The two agentic-delivery-scope commits of #5124: `dispatcher` is PR #5125
(VTID-05737); `dispatcher-pm` (VTID-05736) edits three files outside its paths (emit.ts, loop.ts, observe-live.ts) plus types/cicd.ts,
and waits for that plan's driver to widen the paths.

| Lane | Branch head | Cut from | Local checks on that head |
|---|---|---|---|
| durable-events | `25878fae3e` | origin/main 707127a079 | tsc 0; 7 suites, 213 tests |
| loop-engine | `da106f4abf` | durable-events | tsc 0; 15 suites, 463 tests |
| loop-rehearsal | `1180e55902` | loop-engine | tsc 0; strict tsc of tests and scripts 0; 9 suites, 288 tests |
| gitlab-executor | `2cfff2efdd` | loop-engine | tsc 0; 62 suites, 1407 tests (delivery-loop, Dev Autopilot, autopilot agent, 4465, 4466, source-type locks) |
| loop-runtime | `243f21d926` | gitlab-executor | tsc 0; 71 suites, 1651 tests |
Together they change exactly the 66 lane files of #5124 with the same bytes as its head `4ab280a456`, except one line of
types/cicd.ts (the PM-only `delivery.retry.scheduled`). The lane files' logs get these entries with the lane PRs (one lane per PR).

