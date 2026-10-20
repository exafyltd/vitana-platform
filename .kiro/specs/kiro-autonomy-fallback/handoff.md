---
slug: kiro-autonomy-fallback
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: approved
updated: 2026-10-20T17:49Z
sparring_record: .kiro/specs/kiro-autonomy-fallback/sparring/verdict.md
vtids: [VTID-05271, VTID-05272, VTID-05273, VTID-05274, VTID-05275, VTID-05276, VTID-05277, VTID-05278]
---
# Handoff — kiro-autonomy-fallback (Claude optional; Kiro runs the pipeline end to end; the waits removed)
Planner: Kiro seat `exafyltd` (session kiro-exafyltd-202610201618-c018). Plan: `plan.md` (between the plan markers),
sparred by CI PLAN-SPAR. Detail: `tasks.md`. Lanes (held at `ready` until PLAN-SPAR allocates each lane's VTID):
`steering-rules` (lands first), `plan-spar-allocation`, `pm-fallback` (after `scope-check`), `scope-check`,
`exceptions-seat`, `reviewer-agent`, `pipeline-speed`, `staging-proof` (after all others). Acceptance by the reviewer
agent `vitana-lane-reviewer` (claude-sonnet-5.5). Bootstrap and the owner's merge instruction: `plan.md` §6.
## Log
### 2026-10-20T17:20Z · kiro-exafyltd-202610201618-c018 · created → drafted
Owner instructions 2026-10-20 in the Kiro IDE session (recorded in substance; part of this plan):
- "The process must be built so that Claude is optional; if Claude is not available, Kiro executes the full pipeline
  without Claude", with sparring as is, CI-allocated fresh VTIDs and every existing step, all the way to verified
  staging for the owner to test before production.
- "No more approvals, you run it end to end": a collaboration.md §7b owner-directed merge instruction for the named set
  = this plan's `plan(` PR and every lane PR of this plan (either repo, incl. fix-forward PRs), merge to `main` + staging
  auto-deploy only; the Project Manager merges if it acts first. `gh pr merge --admin` only when a governance-artifact
  check fails as a known false positive for this change (Lane scope failing solely because of the executor:claude /
  governance-path / reviewer rule, or because the spec is not on `main` yet); a real red test or build is never
  overridden.
- Protected gate files changed by this plan (`CLAUDE.md`, the `plan-spar.mjs` allocation code,
  `services/gateway/src/services/plan-sparring/**`, `PLAN-SPAR.yml`, the PM governance guard, the `vtid_ledger` gate
  migrations) are covered by the owner's explicit instruction for this plan only; each one is logged.
- Approvals come from the specialized reviewer agent `vitana-lane-reviewer` on model `claude-sonnet-5.5`, never from
  other Kiro seats or sessions.
- Lane `steering-rules` lands first; the other lanes build in parallel and merge after it, one merge at a time (merge
  lock), each brought up to date with latest `main` and green on that head.
- "Claude optional, reviewer agent approvals, remove the waits, parallel by default, measurement"; the pipeline is the
  default for every future Kiro IDE and Kiro Web session. Final scope approved by the owner with "execute".
Production stays forbidden. Premises checked against vitana-platform@e6ed415a9 (= origin/main 1acb6b92d for every file
named) and vitana-v1@996bfaf1d, from eight read-only lane investigations. No VTID allocated, no code changed, no live
system touched. Next: PLAN-SPAR spars this PR; this session answers each round in `sparring/responses-<n>.md`; on
convergence CI allocates the VTIDs and the plan PR is merged to `main` under the instruction above.

### 2026-10-20T17:49Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 8 lane(s) got a VTID and are handed to Kiro.
