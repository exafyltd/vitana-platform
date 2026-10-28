# Sparring round 1 — in_progress

Session: `7f4644ff-017d-43db-88c7-a2df2f2f0dc8` · plan hash `4c3226b59350976b3ad462c7f028a8b14576a51bc5c3662961809cb723918b5b`

## Summary

The plan is well-grounded in the actual codebase. All major premises — the 20 public-auth parity ledger rows (5 registry + 15 exclusion), the status breakdown (2 exception, 5 in_progress, 13 not_started), the existing linking/auth infrastructure (resolve-link.ts, link-router.ts, auth-port.ts, sign-in.ts), the App.tsx route positions, and the production safety mechanisms (assertNotProduction, no production profile) — were verified against the pinned commit and hold. The lane partition (10 + 9 + 1 = 20) checks out with zero overlap and zero orphan. No blocker or major issues found; one minor observation raised.

## Findings

### R1-F1 [minor]

The parity ledger shell section shows the PublicShell component (the native equivalent of PublicAppShell) at status 'in_progress' (owner N3 VTID-05186). The plan says all signed-out public-legal screens are rendered through the PublicAppShell branch at '1:1 parity with today's mobile web screens', but does not acknowledge that the native PublicShell itself is still in_progress. If the PublicShell visual chrome is incomplete, the public-legal lane's parity assertion may not be fully achievable until the shell itself reaches 'native' status.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:141` — "key": "PublicShell",
"web_source": "src/components/PublicAppShell.tsx",
"native_source": "apps/mobile/src/shell/components/PublicShell.tsx",
"status": "in_progress",
"exception": null,
"owner": "N3 VTID-05186",

Suggestion: Either explicitly note that the public-legal lane depends on the PublicShell reaching sufficient visual parity (and sequence accordingly), or add a statement that the lane builds on the functional PublicShell as-is and that visual polish will be a separate shell-parity task. This avoids the lane claiming '1:1 parity' when the shell chrome underneath is itself incomplete.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
