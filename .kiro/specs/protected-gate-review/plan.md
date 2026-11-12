---
change_class: standard
---
# Plan — protected-gate-review

Author: Claude Code session `session_01Cp885FfhfWqu4KXDE5NRMh` (owner decision, 2026-11-12: "go with option 2").
Scope: the rule for how an owner-approved change to a protected gate file (collaboration §3a) is reviewed before merge.
Docs and rules only. No runtime code.

<!-- plan:begin -->
## Goal
A protected gate file (`scripts/collab/queue.mjs`, `scripts/collab/plan-spar.mjs`, `CLAUDE.md`, and the rest of the
list in `scripts/collab/protected-gate-files.json`) can today merge only with (a) the owner's instruction naming the plan
AND (b) a reviewer-agent accept on the final head. The reviewer agent runs only in a Kiro session, and the validator
(`scripts/collab/queue.mjs`, lane checks) additionally requires `executor: claude` or two reviewer-agent accepts from
different chain models for a lane touching these files. Result: an owner-approved, sparred change to a protected
gate file cannot land (PR #5009: the exception implementation for `collab-lane-close-exception`).

## Measured state (origin/main)
- `.claude/rules/collaboration.md` §3a: protected files "never merge on a reviewer-agent accept alone: they need the
  owner's instruction naming the plan plus a reviewer-agent accept on the current head".
- `scripts/collab/queue.mjs` lane validation: a lane whose paths reach a protected file needs `executor: claude`, or
  `protected_gate: two-model` with `reviewer_seat: agent:vitana-lane-reviewer` (two accepts from different chain models).
- `.kiro/agents/vitana-lane-reviewer.md`: read-only sub-agent, dispatched by a Kiro session; no path for a Claude
  session to run it.

## Options for the owner's decision (recorded here; the owner picks at Gate 1)
- **A — unchanged.** Keep the current two-accept rule. Only a Kiro-side reviewer run can unlock a protected change.
- **B — owner-approved sparred plan.** For a `plan(` PR that converged and was policy-approved and whose plan lists
  its exact protected files, the owner's merge instruction naming the plan replaces the reviewer accept. The reviewer
  agent is still required for every other lane. The approval is recorded in the lane file and the PR.
- **C — one reviewer-agent accept from a different model than the planner, plus the owner's instruction.** Relaxes
  "two accepts from different chain models" to one.

**Recommendation: B** for changes whose plan lists exact files, because the sparring round already reviewed them.
Option A remains the rule for any change not covered by a converged plan.

## Scope of enforcement (R1-F1, R1-F3, R1-F4, R1-F5)
Enforcement points for any option other than A (R2-F1 corrected: only the first, third and fourth items are protected):
1. `scripts/collab/queue.mjs` — lane declaration check (`scopeCheck`, `isTwoModelLane`, `PROTECTED_GATE_TWO_MODEL`).
   Runs at PR-GATE time on the lane file.
2. `scripts/collab/land-guard.mjs` — merge-time count (`PROTECTED_ACCEPTS_REQUIRED = 2`, `mergeDecision`). NOT a protected
   gate file (R2-F1): it is a governance path (`scripts/collab/**`), so changing it needs one governance-level
   reviewer-agent accept, not two distinct-model accepts. It must not be added to `protected-gate-files.json`.
3. `services/gateway/src/services/project-manager/governance.ts` — PM merge-time count (`PROTECTED_ACCEPTS_REQUIRED`,
   `protectedAcceptModels`).
Plus the invariant file `scripts/collab/gate-invariants.test.mjs` (protected; pins the two-model rule and refuses one
accept) and `scripts/collab/protected-gate-files.json`.

Stale text (R1-F5): `.claude/rules/collaboration.md` §3a ("owner instruction + one reviewer accept") and the
`queue.mjs` comment near line 89 describe the superseded VTID-05276/05408 rule. The same stale sentence also appears in
the header of `governance.ts` (lines 4-7). The inline protected-file list in `collaboration.md` §3a is two entries behind
`protected-gate-files.json` (it lacks `.github/workflows/VTID-ALLOCATE.yml` and `scripts/collab/gate-invariants.test.mjs`).
All three locations are updated under the chosen option (R3-F1). The enforced rule is the two-model rule
(VTID-05765). Every option below updates the text so that all layers say the same thing.

**Bootstrapping (R1-F6, R2-F1):** a change to `queue.mjs`, `governance.ts`, `gate-invariants.test.mjs` or
`protected-gate-files.json` is itself a protected-gate change. Under the current code it needs two reviewer-agent
accepts from different chain models on the final head, merged under the owner's named instruction. A change to
`land-guard.mjs` needs one governance-level accept. Option A needs no change. Options B and C cannot land without those two accepts, because the rule being
changed is the one that gates the change. This is the owner's decision to make at Gate 1.

## Change (after the owner picks an option at Gate 1)
1. Update `.claude/rules/collaboration.md` §3a, the `queue.mjs` comment, `land-guard.mjs`, `governance.ts`,
   `gate-invariants.test.mjs` and `protected-gate-files.json` to the chosen option, with tests in `queue.test.mjs`
   and `gate-invariants.test.mjs`, all in one PR under the bootstrapping rule above.
2. Re-open the implementation of `collab-lane-close-exception` (PR #5009) under the chosen rule.

## Tests
`node --test scripts/collab/queue.test.mjs` green for the chosen rule. No staging or production test; repository
scripts and rules only.

## Risks
- A loosened protected-file rule could let an unreviewed change land. Mitigation: option B still needs the owner's
  named instruction and a converged, policy-approved plan that lists the exact files.
- The rule change itself is a governance change: this plan goes through sparring and owner approval first.

## Unchanged
Reviewer-accept rule for every other lane; merge rules (§7b); production publish rules (§7c); plan-sparring gate.
<!-- plan:end -->
