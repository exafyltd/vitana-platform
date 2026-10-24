# Sparring round 3 — escalated

Session: `d0c274cd-a9f0-48dd-a0a1-ea6061a344b6` · plan hash `a67a6db20b8f4197c40793d8ec06e23e9c304cf6f934093db9291d1f518d2960`

## Summary

The plan has been substantially improved across three rounds. R2-F2 (LEGACY ratchet) is genuinely addressed. R1-F2 and R1-F3 are accurately documented in the revised plan. One new blocker was introduced by the R2-F1 fix: the s-j-retire-function lane plan assigns the SUPABASE-FUNCTIONS-RETIRE.yml workflow dispatch to Claude Code while executing a lane, which collaboration.md §7a explicitly prohibits for Claude Code in that context. Everything else I can verify from the pinned vitana-platform commit holds.

## Findings

### R3-F1 [blocker]

The s-j-retire-function lane plan assigns the SUPABASE-FUNCTIONS-RETIRE.yml workflow dispatch to Claude Code during lane execution. This directly violates collaboration.md §7a, which applies to 'Claude Code whenever it executes a lane' and lists 'dispatch a workflow' as a never-do. The plan acknowledges this constraint but misreads it as applying only to Kiro: 'S-J closes when that lane is done — Kiro never dispatches or writes live (§7a).' The word 'Kiro' is wrong; §7a begins 'Applies to Kiro (as executor, reviewer or planner), and to Claude Code whenever it executes a lane.' Immediately before that parenthetical, the prohibited actions include 'merge or approve a PR on GitHub (the Project Manager merges), dispatch a workflow, or deploy.' There is therefore no authorized executor for the dispatch step as currently written: Kiro is prohibited, Claude Code in a lane is prohibited, and no other actor (Project Manager, owner) is named. The plan's stated S-J closure condition — that the function list shows linkedin-import absent — therefore has no actor who can legally trigger the step it depends on.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:158` — ## 7a. What the executor and the reviewer never do
Applies to Kiro (as executor, reviewer or planner), and to Claude Code whenever it executes a lane. They never:
- allocate a VTID (CI and the coordinator do), take a `_plan` claim of a plan they did not author, or edit another lane's file;
- merge or approve a PR on GitHub (the Project Manager merges), dispatch a workflow, or deploy;
- review their own lane (a lane's seat never reviews it);
- writes to a live system, even though its credentials allow it: no Supabase writes (`execute_sql` with
INSERT/UPDATE/DELETE/DDL, `apply_migration`, `deploy_edge_function`, branch/project/secret tools) and no mutating
AWS call (ECS, ELB, ECR, IAM or Secrets Manager writes).
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:129` — **Kiro plans, builds and reviews; the Project Manager merges and sends Gate 2; Claude Code handles exceptions**
...
- **Merging and Gate 2 — the Project Manager**
...
- **Claude Code — exceptions only:** `executor: claude` lanes, lanes nobody picked up (reassigned to `claude`), parked
plans and lanes it can fix, partner outages, and anything touching a governance path.

Suggestion: The workflow dispatch is a live-system action that cannot be performed by a lane executor under §7a. Assign it explicitly to the Project Manager. Concretely: after the s-j-retire-function PR merges, the Project Manager dispatches SUPABASE-FUNCTIONS-RETIRE.yml (this is the 'Gate 2' equivalent for a function-deletion operation). The Confirm read (a read-only call to the Supabase management API listing deployed functions) can then be performed by Claude Code outside of active lane execution and committed to docs/validation/<vtid>/ as a follow-up step under the coordinator role, or the Project Manager records it. Update the lane description to name the Project Manager (not 'the same lane') as the dispatch actor, and describe any post-merge Confirm commit as a coordinator (_plan claim) step, not a lane-execution step.

## Acknowledgements of earlier responses

- R2-F1: disputed — Accepted and acted on, but the fix introduced a new §7a violation (R3-F1 above). The plan correctly adds an executor:claude lane with its own VTID for the ALLOWLIST edit, satisfying the original finding. However, it then assigns the actual RETIRE workflow dispatch to that lane's executor ('the same lane, under its VTID, dispatches the workflow'), which §7a prohibits for Claude Code when executing a lane. The rationale states 'Kiro never dispatches or writes live (§7a)' — this misreads §7a as Kiro-only, when the rule explicitly covers Claude Code in lane execution context. The governance gap identified in R2-F1 is therefore not fully closed: the lane has a valid PR scope, but the dispatch step lacks an authorized actor.
- R2-F2: acknowledged — The LEGACY ratchet approach fully addresses the concern. All 59 pre-caller-auth functions are enumerated in-script with pattern tags; the map only shrinks; a LEGACY key with no folder fails the gate; the 22 C-unreviewed functions are tracked residuals in handoff.md; the first CI run is green without touching any function file outside the lane's paths. The mechanics are sound.
