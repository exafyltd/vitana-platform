---
slug: delivery-loop-engine
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-19T19:50Z
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

All lane code and tests exist on `kiro/delivery-loop-engine/gitlab-executor` (draft PR, no VTID). Once VTIDs exist, each lane is cut
from it into its own branch from `origin/main`.

Coordination: Kiro 5's autopilot GitLab port plan (GitLab MR !1, closed draft, items P2, P3, P16, P23) covers a full GitHub-to-GitLab
switch of Dev Autopilot. The `gitlab-executor` lane is the narrow part it needs first (one repair path, P16's clone form, P23's GitLab
double in the operator suite) and does not build P2's `SCM_PROVIDER` switch. Kiro 4 and Kiro 5 are named on the plan PR.

Next: the owner's ruling on #5122 (or another sparring path); then PLAN-SPAR spars this PR, policy approval allocates the VTIDs, and
the driver cuts the lanes.
