# Sparring round 1 — in_progress

Session: `6b473db9-a755-45be-951d-0dba83663ee8` · plan hash `fe8c5891b7b83a817a717e2f4def70a772e1a9c3183a101993f18bec31a685e3`

## Summary

The plan's core premises about governance.ts, queue.mjs, guard.cjs, types.ts, and the collaboration rules are accurate at the pinned commit. Four issues were found: one major security gap (DRIVER-WAKE.yml omitted from the protected gate list), one major implementation blocker (plan-merge.mjs cannot directly import the TypeScript canonical-hash module), one minor ambiguity in the reviewSatisfiesLane insertion point, and a minor operational gap around collab-wake ref accumulation. One premise about the collaboration.md path is imprecise but non-blocking.

## Findings

### R1-F1 [major]

DRIVER-WAKE.yml is not added to the protected gate files list, creating an asymmetric security gap. The plan adds PLAN-PR-MERGE.yml and plan-merge.mjs to PROTECTED_GATE_BUILTIN / PROTECTED_GATE_GLOBS / protected-gate-files.json (lane 2, point 4), but omits DRIVER-WAKE.yml. The wake workflow holds KIRO_API_KEY, has permissions: contents: write, and installs Kiro CLI — a higher-value target than the merge workflow, yet the merge workflow is protected while the wake workflow is not.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:92` — export const PROTECTED_GATE_BUILTIN = ['CLAUDE.md', 'scripts/collab/plan-spar.mjs', 'scripts/collab/queue.mjs', 'scripts/collab/protected-gate-files.json', 'services/gateway/src/services/plan-sparring/**', 'services/gateway/src/services/project-manager/governance.ts', '.github/workflows/PLAN-SPAR.yml', '.github/workflows/PR-GATE.yml', '.github/workflows/AWS-PROD-*.yml', '.kiro/agents/vitana-lane-reviewer.md', 'supabase/migrations/*vtid_ledger*.sql', 'supabase/migrations/*plan_sparring*.sql'];
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:44` — export const PROTECTED_GATE_GLOBS: readonly string[] = Object.freeze([ 'CLAUDE.md', 'scripts/collab/plan-spar.mjs', ... '.github/workflows/PLAN-SPAR.yml', '.github/workflows/PR-GATE.yml', '.github/workflows/AWS-PROD-*.yml', ...])
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:253` — no protected gate file (§3a) is changed without a legacy `claude` review on the current head or the owner's instruction.

Suggestion: Add '.github/workflows/DRIVER-WAKE.yml' to PROTECTED_GATE_BUILTIN (queue.mjs), PROTECTED_GATE_GLOBS (governance.ts), and protected-gate-files.json in the same atomic commit that lane 2 already performs for PLAN-PR-MERGE.yml and plan-merge.mjs. The rationale is identical to why PLAN-SPAR.yml and PR-GATE.yml are protected: a workflow that carries a privileged secret and writes git refs must require a Claude or owner review to change.

### R1-F2 [major]

plan-merge.mjs is a .mjs Node script in scripts/collab/ but the plan says it imports the canonical plan-block hash function from the TypeScript service source. observe-live.ts imports canonicalPlanHash from '../plan-sparring/canonical-hash' — a TypeScript-to-TypeScript import that a plain .mjs script in scripts/collab/ cannot replicate at runtime without compilation or an alternative distribution mechanism. The plan says only 'same hash function as PLAN-SPAR, imported read-only' with no mechanism specified.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/observe-live.ts:25` — import { canonicalPlanHash } from '../plan-sparring/canonical-hash';
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1` — // scripts/collab/queue.mjs

Suggestion: The plan must specify one of: (a) extract the hash function into a self-contained scripts/collab/canonical-hash.mjs that both plan-spar.mjs and plan-merge.mjs import, adding it to the protected gate list; (b) compile and vendor it as a CJS artifact alongside guard.cjs; or (c) invoke the already-compiled gateway binary read-only. Leaving this unresolved means the CI script fails at import time.

### R1-F3 [minor]

The plan's description of where to insert the isIndependentReview branch in reviewSatisfiesLane is ambiguous. The function has an early-exit gate `if (r.reviewer) return false` at line 163. Independent reviews always carry a truthy reviewer field (e.g. 'agent:vitana-lane-reviewer-independent (model)'). If the new branch is inserted after line 163 rather than between lines 162 and 163, all independent reviews are silently discarded.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:159` — export function reviewSatisfiesLane(lane: ObservedLane, r: ReviewEntry): boolean {
  const pr = lane.pr;
  if (!pr) return false;
  if (isAgentReview(r)) return reviewOnCurrentHead(r, pr);
  if (r.reviewer) return false;
  if (r.verdict !== 'approve') return false;
  if (r.reviewer_seat !== lane.reviewer_seat) return false;
  if (r.head_sha !== pr.head_sha) return false;
  if (laneTouchesGovernance(lane) && lane.reviewer_seat !== GOVERNANCE_REVIEWER) return false;
  return true;
}

Suggestion: Explicitly state in the lane 2 spec: 'Insert the isIndependentReview branch immediately after the isAgentReview branch (after line 162) and before the if (r.reviewer) return false guard (line 163).' The test case 'independent accept on non-governance lane -> reviewSatisfiesLane true' will catch the wrong ordering, but the plan should be unambiguous so the implementer does not depend on a failing test to discover the error.

### R1-F4 [minor]

The plan creates refs/heads/collab-wake/<slug> marker refs but specifies no cleanup or TTL. With many plans the set grows unbounded; the 6-per-hour budget check must scan all collab-wake/ refs by committer date, making it O(plan count) per wake event. No cleanup mechanism analogous to ref deletion is described.

- `exafyltd/vitana-platform:.claude/rules/collaboration.md:316` — Heartbeat: ref `refs/heads/collab-driver/<slug>` — a commit whose tree equals `origin/main^{tree}` (no workflow triggers), parent the previous tip (fast-forward only, never forced), trailers `Collab-Session: <driver session>`, `Collab-Driver: <slug>`. Interval <= 15 min.
- `exafyltd/vitana-platform:scripts/collab/plan-driver.mjs:30` — export const ALIVE_MS = 45 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
export const DEFAULT_CAP = 6;

Suggestion: Add a cleanup pass in driver-wake.mjs (or a periodic step) that deletes collab-wake/<slug> refs older than 2 h, matching the pattern of how stale claims are broken. Alternatively, document explicitly that accumulated stale refs are harmless and bound the scan cost (e.g. 'at most N collab-wake refs will exist for completed plans').

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
