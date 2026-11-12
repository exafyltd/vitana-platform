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

## Change (after the owner picks an option at Gate 1)
1. Update `.claude/rules/collaboration.md` §3a and the lane-validation text in `scripts/collab/queue.mjs` to the chosen
   option, with its tests in `scripts/collab/queue.test.mjs`.
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
