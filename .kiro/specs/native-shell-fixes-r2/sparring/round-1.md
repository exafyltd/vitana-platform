# Sparring round 1 — in_progress

Session: `f2d7dc32-1f2a-4855-b80f-0fc11c3bee6c` · plan hash `38340af9d4cc6bacd5e1329dc170063c45a01688870191f56e249dc9247ee2e3`

## Summary

The plan is well-analyzed. All major premises about the doubled `/api/v1` prefix, the AuthGate redirect behavior, the web's AuthGuard commerce redirect, guest paths, and the test fixture were verified against the pinned code. The three bugs are real and the proposed fixes are appropriate. No blockers or major issues found. One minor concern about completeness of the gatewayGet audit.

## Findings

### R1-F1 [minor]

The plan fixes two gatewayGet call sites with the doubled /api/v1 prefix (useMyPartnerOrgs.ts and GuidedModeProvider.tsx) but does not explicitly confirm these are the only two callers. If other files import gatewayGet and pass a path starting with /api/v1, they would have the same bug and would not be fixed by this lane.

- `exafyltd/vitana-v1:apps/mobile/src/auth/gateway.ts:23` — export function gatewayGet<T>(path: string): Promise<T> {
  return gatewayJson<T>(getGateway(), path);
}
- `exafyltd/vitana-v1:apps/mobile/src/identity/useMyPartnerOrgs.ts:7` — import { gatewayGet } from '../auth/gateway';
- `exafyltd/vitana-v1:apps/mobile/src/identity/GuidedModeProvider.tsx:14` — import { gatewayGet } from '../auth/gateway';

Suggestion: Add a grep/search step to the implementation checklist that confirms exactly which files import gatewayGet (or gatewayJson + getGateway) and that none of them pass a path beginning with /api/v1. Document the result in the lane log so the reviewer can verify completeness.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
