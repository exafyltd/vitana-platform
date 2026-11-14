# Sparring round 2 — in_progress

Session: `334750e7-4cb7-46ec-95ae-74f10c89fcee` · plan hash `3aad74f127447aa56825159afebb01c92c8c6158324d6cd45e9f77c470c5e183`

## Summary

All three R1 findings were accepted and are addressed in the revised plan. Two new issues emerge: (1) gitlab-land.mjs — the active GitLab merge bot — is a caller of mergeDecision and protectedTouched that the plan does not mention, yet it is the live merge path; (2) the plan names governance.ts lines 197-198 as a target but does not describe how the protectedApproval data reaches the gateway service (ObservedLane lacks the needed fields, the function signature needs changing, and act.ts callers need updating).

## Findings

### R2-F1 [major]

The plan describes three enforcement sites for protectedApprovalOk: queue.mjs scopeCheck, land-guard.mjs mergeDecision, and governance.ts. It does not mention scripts/eng/gitlab-land.mjs, which is the active GitLab merge bot. gitlab-land.mjs imports mergeDecision and protectedTouched from land-guard.mjs (line 48) and PROTECTED_GATE_PATHS from queue.mjs (line 49). It is the code that actually lands merge requests on GitLab (line 1: 'The merge bot of the self-hosted GitLab'). When Phase 3 modifies mergeDecision to accept a protectedApproval argument, gitlab-land.mjs must also compute and pass that data (plan front-matter, trailers) from the GitLab merge request. Without this, protectedApproval will be absent/undefined at the only active merge path, and the predicate will fail closed — safe, but no protected file can ever merge on GitLab, making the feature unreachable.

- `exafyltd/vitana-platform:scripts/eng/gitlab-land.mjs:1` — // The merge bot of the self-hosted GitLab ...
import { laneKeyOf, localAfter, reviewCurrent, checksVerdict, protectedTouched, mergeDecision } from '../collab/land-guard.mjs';
import { commitsInRange, PROTECTED_GATE_PATHS, GOVERNANCE_PATHS } from '../collab/queue.mjs';
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:107` — /** Merge decision from the gates. */
export function mergeDecision({ review, checks, behindBy, protectedFiles = [] }) {
  if (protectedFiles.length) return { ok: false, code: 1, reason: `protected gate file(s) changed ...` };
- `exafyltd/vitana-platform:.kiro/pipeline/lane-land.md:38` — Merge with `node <vitana-platform>/scripts/collab/land-guard.mjs merge --gh <owner/repo> --pr <n> --reviewed-head <Collab-Reviewed-Head> --title "<title>" --wait 3600`

Suggestion: Add gitlab-land.mjs to the Phase 3 change list. Describe how it reads the protectedApproval data (plan front-matter fields from the spec checkout, reviewer/author seat trailers from the merge request's commits) and passes it to mergeDecision. Since gitlab-land.mjs imports from land-guard.mjs to avoid rule drift (line 12-13), the protectedApproval flow should go through the same shared mergeDecision function, not a second code path.

### R2-F2 [major]

The plan says 'governance.ts (lines 197-198) receive the same object from their callers' but does not describe the data path into the gateway service. ObservedLane (types.ts lines 113-160) has no fields for sparring_verdict, plan_hash, or protected_files. governanceMergeAllowed's signature is (lane: ObservedLane, pr: ObservedPr | null, review: ReviewEntry | null) with no protectedApproval parameter. The caller in act.ts line 224 passes (lane, lane.pr, latestReview(lane)) — there is no source for the approval data. Phase 3 names the target line (197-198) but not the changes to the type, the function signature, the observer that populates the data, or the act.ts call site. Without those, the TypeScript predicate has no data to evaluate.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:185` — export function governanceMergeAllowed(
  lane: ObservedLane,
  pr: ObservedPr | null,
  review: ReviewEntry | null,
): GovernanceVerdict {
  ...
  if (touchesProtectedGate(files)) {
    return { ok: false, reason: 'protected_gate_file' };
  }
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/types.ts:112` — /** A lane as the PM observes it. */
export interface ObservedLane {
  slug: string;
  lane: string;
  vtid: string | null;
  state: LaneState;
  seat: string;
  reviewer_seat: string;
  ...
}
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/act.ts:218` — async function actMerge(decision: MergeDecision, state: ObservedState, deps: Bound): Promise<ActResult> {
  const lane = findLane(state, decision.slug, decision.lane);
  if (lane) {
    const g = governanceCheck(lane, lane.pr, latestReview(lane));
    if (!g.ok) {
      return { decision, status: 'governance_blocked', detail: `${g.reason}: ...` };
    }
  }

Suggestion: Phase 3 should describe: (a) a ProtectedApproval type or fields added to ObservedLane (sparring_verdict, plan_hash, protected_files from the lane's plan front-matter); (b) how the observer populates them (reading the spec's handoff.md on main); (c) a new parameter or field on governanceMergeAllowed for the approval data; (d) the act.ts change to pass it through. The shared fixture test should cover the gateway data path, not just the predicate in isolation.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
