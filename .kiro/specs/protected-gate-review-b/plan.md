---
change_class: standard
---
# Plan — protected-gate-review-b

Author: Claude Code session `session_01Cp885FfhfWqu4KXDE5NRMh`. Owner decision 2026-11-12: option B of
`protected-gate-review` (PR #5010). This plan carries only the option B spec, because the converged session of
`protected-gate-review` predates it. Docs and rules are reviewed here; runtime code follows only after this converges.

<!-- plan:begin -->
## Goal
A protected gate file change (`queue.mjs`, `governance.ts`, `gate-invariants.test.mjs`, `protected-gate-files.json`)
can merge on the owner-approved path (option B) without a second reviewer-agent accept, once this rule is in force.

## Measured state (origin/main)
- Protected-file merge needs two reviewer-agent accepts from different chain models: `land-guard.mjs`
  `PROTECTED_ACCEPTS_REQUIRED = 2`, `governance.ts`, `queue.mjs` `isTwoModelLane`. `land-guard.mjs` is a governance
  path (one accept), not a protected file.

## Chosen option: B (owner decision, 2026-11-12) — code-level spec (R2-F2, R2-F3)
Owner-approved sparred plan replaces the reviewer accept for the protected files the plan lists. The reviewer agent is
still required for every other lane. Two stages, as R1-F4 requires:

**Stage 1 — lane declaration (`queue.mjs`, PR-GATE).**
- A plan's front matter lists `protected_files:` (exact paths, no globs beyond the existing protected list).
- A lane may declare `protected_gate: owner-plan` and `plan: <slug>`. Accepted only if (a) the plan's verdict file
  `sparring/verdict.md` says `CONVERGED and approved by policy converged-auto-v1`, (b) the lane's changed protected
  paths are a subset of the plan's `protected_files:`, and (c) the lane declaration is read from the trusted base
  revision of the lane file (as `isTwoModelLane` does today).
- New export `isOwnerPlanLane(fm, planFm, verdictText, changedProtected)` in `queue.mjs`.

**Stage 2 — merge time (`land-guard.mjs` `mergeDecision`, and `governance.ts`).**
- A protected change is mergeable on the owner-plan path only if the PR carries the commit trailer
  `Owner-Approved-Plan: <slug>` on a commit authored by the owner's account (`exafyltd`), and the same stage-1 checks
  hold at the merge head. Otherwise the two-model rule (two accepts, different models) still applies.
- One reviewer accept alone never unlocks a protected file. The owner-plan path needs no accept.

**Invariants (`gate-invariants.test.mjs`, new assertions, protected):**
1. Without `protected_gate: owner-plan`, zero, one or two same-model accepts still refuse a protected change.
2. With the owner-plan path, a missing or non-converged verdict refuses the merge.
3. With the owner-plan path, a changed protected path outside `protected_files:` refuses the merge.
4. A `PROTECTED_ACCEPTS_REQUIRED` value of 1 still fails the mutation test.

**Text:** `collaboration.md` §3a and the `queue.mjs` comment rewritten to describe both paths; the protected list in
§3a brought up to date (R3-F1).

**Bootstrapping (unchanged):** this change edits `queue.mjs`, `governance.ts`, `gate-invariants.test.mjs` and
`protected-gate-files.json`, so it needs two reviewer-agent accepts from different chain models on its final head under
the current rule. The owner-plan path applies only after this PR lands.

## Round 1 answers — concrete mechanism (R1-F1 … R1-F5)
- **Data path to the PM (R1-F1, option a; R2-F1 corrected):** the observer that builds `ObservedPr` adds
  `ownerPlanApproved: boolean`. The gateway cannot import `scripts/collab/`, so the check is implemented twice, as the
  repo already does for accept counting (`governance.ts` and `land-guard.mjs`): a TypeScript port in the observer and
  the `isOwnerPlanLane` function in `queue.mjs`. A parity test (`services/gateway/test/project-manager/owner-plan-parity.test.ts`)
  feeds both the same representative inputs and asserts the same verdict. `governanceMergeAllowed` reads only `pr.ownerPlanApproved`; its signature is
  unchanged apart from that optional field. Without it the PM path stays two-model, as today.
- **Gateway tests (R1-F2):** a jest suite `services/gateway/test/project-manager/governance-owner-plan.test.ts` with the
  four cases: valid verdict + trailer → allowed; missing or non-converged verdict → refused; changed file outside
  `protected_files:` → refused; no trailer → refused. The suite is part of the implementation PR's test plan.
- **Plan validation (R1-F3):** `validatePlan` rejects a `protected_files:` entry that matches no `PROTECTED_GATE_PATHS`
  glob, (R3-F1: the `change_class` guard is dropped, because `change_class` is not a handoff field and the verdict and subset checks carry the safety.)
- **Mutation tests (R1-F4):** `gate-invariants.test.mjs` adds two mutations: removing the verdict-convergence check in
  `isOwnerPlanLane` must fail; removing the `protected_files` subset check must fail.
- **Deployment (R1-F5):** `governance.ts` takes effect when the gateway next deploys. Staging verification of the
  PM merge-guard on a test PR comes before any production promotion, under the normal staging gate.

## Tests (R2-F2: gateway tests are listed and the qualifier is removed)
- `node --test scripts/collab/queue.test.mjs` and `scripts/collab/gate-invariants.test.mjs` for the option B invariants.
- Gateway jest: `services/gateway/test/project-manager/governance-owner-plan.test.ts` (four cases from R1-F2) and
  `services/gateway/test/project-manager/owner-plan-parity.test.ts` (R2-F1 parity).
- Staging is verified only after merge, under the normal staging gate (R1-F5).

## Risks
- Loosening the protected-file rule could let an unreviewed change land. Mitigation: the owner-plan path needs a
  converged, policy-approved plan that lists exact files, plus the owner's trailer at merge.

## Unchanged
Reviewer-accept rule for every other lane; merge rules (§7b); production publish rules (§7c); plan-sparring gate.
<!-- plan:end -->
