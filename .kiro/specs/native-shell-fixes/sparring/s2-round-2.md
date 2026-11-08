# Sparring round 2 — converged

Session: `bb8b09d5-b6ca-45a7-be71-52f17e443da3` · plan hash `5bff3499c9b0d62b4dc26b25a1b3239f61d95af745ee3f8532889e8176368ac5`

## Summary

Round 2 review of the revised native-shell-fixes plan. All major premises verified against the pinned commit. R1-F1 was accepted and properly addressed in the revised plan (decision 4 adds the four NATIVE_ROUTES entries, resolve.ts is added to lane paths, sequenced after #1587). No new blockers or major issues found.

Verified premises:
- Bug 1: doubled `/api/v1` prefix in useMyPartnerOrgs.ts:23 confirmed.
- Bug 2: doubled `/api/v1` prefix in GuidedModeProvider.tsx:71 confirmed.
- Gateway contract: `gatewayApiUrl` returns `${base}/api/v1`, `createGatewayFetch` concatenates `${api}${rel}` — callers must pass path after `/api/v1`.
- Bug 3: AuthGate.tsx:46 sends all non-guest signed-out users to `/maxina` with no commerce branch.
- Web parity: AuthGuard.tsx:65 returns `/commerce/join` for commerce paths.
- Guest path matching: `matchPattern` does exact segment match, so `/commerce` in GUEST_PATHS does not match `/commerce/team`.
- Test fixture at identity.test.tsx:149 encodes the bug; decision 6 corrects it.
- `__setGatewayForTests` at gateway.ts:19 enables the plan's real-prefix test approach.
- NATIVE_ROUTES and navigation.test.tsx enforce route-file/list consistency — R1-F1 fix properly scoped.

## Findings

_none_
## Acknowledgements of earlier responses

- R1-F1: acknowledged — Properly addressed. Decision 4 adds the four NATIVE_ROUTES entries, resolve.ts is included in the lane's paths, and the edit is sequenced after #1587 merges. The navigation.test.tsx coverage is included in the test plan.
