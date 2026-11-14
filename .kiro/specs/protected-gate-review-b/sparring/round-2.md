# Sparring round 2 — in_progress

Session: `c221868c-7dc1-400b-b306-1d366d778b2f` · plan hash `45f62aa5460b6670db334cbabfdad675837c8eb14b9871b72660d2f285a016ce`

## Summary

All five R1 findings were accepted. R1-F2 through R1-F5 are adequately addressed in the revision. R1-F1 is partially addressed: governance.ts now reads only a boolean `pr.ownerPlanApproved`, which is clean, but the plan's claim of "one implementation, shared by the observer and land-guard" is architecturally unresolved — the gateway TypeScript service has no import path to `scripts/collab/` today, and the existing pattern for protected-gate checks is independent implementations (governance.ts vs land-guard.mjs each have their own `protectedAcceptModels`), not shared code. Two new findings raised.

## Findings

### R2-F1 [major]

The plan claims 'one implementation, shared by the observer and land-guard' for computing `ownerPlanApproved`, but the gateway's TypeScript observer (`observe-live.ts`) has no import path to `scripts/collab/queue.mjs` or `land-guard.mjs`. The existing codebase pattern for the same concept (protected-gate accept counting) is two independent implementations: `governance.ts` has its own `protectedAcceptModels` (lines 67-76) and `land-guard.mjs` has its own (lines 117-125). observe-live.ts imports only from `../plan-sparring/`, `./github-rest`, `./observe`, and `./types` — never from `scripts/collab/`. Without specifying the actual import mechanism (a new shared package? a TS port? or honest defense-in-depth duplication like the existing pattern?), the 'shared function' claim is unimplementable.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/observe-live.ts:25` — import { canonicalPlanHash } from '../plan-sparring/canonical-hash';
import { GithubHttpError, gh, ghPages, supaRest } from './github-rest';
import type { PmObserver } from './observe';
import type {
  AreaSeatRotation,
  CheckRun,
  CheckConclusion,
  ExecutingLogEntry,
  LaneState,
  ObservedBookkeepingPr,
  ObservedClaude,
  ObservedLane,
  ObservedPlanPr,
  ObservedPlanSparring,
  ObservedPr,
  ObservedState,
  PmMode,
  ReviewEntry,
  ReviewVerdict,
} from './types';
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:65` — /** VTID-05765: distinct chain models whose agent accept is on the PR's current head. */
export const PROTECTED_ACCEPTS_REQUIRED = 2;
export function protectedAcceptModels(reviews: readonly ReviewEntry[], pr: ObservedPr | null): string[] {
  if (!pr) return [];
  const models = new Set<string>();
  for (const r of reviews) {
    if (!isAgentReview(r) || !reviewOnCurrentHead(r, pr)) continue;
    const m = /\(([^)]+)\)\s*$/.exec(String(r.reviewer ?? '').trim());
    if (m && REVIEWER_AGENT_MODELS.includes(m[1])) models.add(m[1]);
  }
  return [...models];
}
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:117` — export function protectedAcceptModels(entries) {
  const models = new Set();
  for (const e of entries || []) {
    if (!e || e.verdict !== 'accept' || !e.current) continue;
    const m = new RegExp(`^${REVIEWER_AGENTS[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(([^)]+)\\)$`).exec(String(e.reviewer || '').trim());
    if (m && REVIEWER_MODELS.includes(m[1])) models.add(m[1]);
  }
  return [...models];
}

Suggestion: Either (a) adopt the existing defense-in-depth pattern: the observer implements its own owner-plan check in TypeScript, independently from `isOwnerPlanLane` in queue.mjs, and add a parity test that both implementations agree on representative inputs; or (b) extract the shared logic to a pure ESM module under a location both consumers can import (e.g. `packages/collab-shared/`) and name that module in the plan. Either way, specify which approach is used and update the file list.

### R2-F2 [minor]

The plan's Tests section lists only `queue.test.mjs` and `gate-invariants.test.mjs`, and states 'No staging or production test; repository scripts and rules only.' But the R1-F2 answer adds a gateway jest suite `services/gateway/test/project-manager/governance-owner-plan.test.ts` with four cases. This suite tests runtime gateway code and must be run as part of the implementation. The Tests section should enumerate it alongside the collab script tests so it is not missed during implementation review.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:200` — export function governanceMergeAllowed(
  lane: ObservedLane,
  pr: ObservedPr | null,
  review: ReviewEntry | null,
  reviews: readonly ReviewEntry[] = lane.reviews ?? (review ? [review] : []),
): GovernanceVerdict {
  const files = pr?.files ?? lane.paths;
  if (touchesProtectedGate(files)) {
    if (protectedAcceptModels(reviews, pr).length < PROTECTED_ACCEPTS_REQUIRED) return { ok: false, reason: 'protected_gate_file' };
    return { ok: true };
  }

Suggestion: Add `services/gateway/test/project-manager/governance-owner-plan.test.ts` (jest) to the Tests section and remove the 'repository scripts and rules only' qualifier.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
