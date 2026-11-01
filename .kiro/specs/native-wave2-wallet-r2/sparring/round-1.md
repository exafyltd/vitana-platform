# Sparring round 1 — in_progress

Session: `45413869-e25c-4a01-95c9-6e9d52e10780` · plan hash `f0438783a20dfcdc52193c9764b1a11b0c2d534a0dfe6383b9df7b4d49c3e9f0`

## Summary

Plan is well-researched and the core premises hold. Verified route lines, auth boundaries, exchangeRates purity, appilix gate locations, core-closure outputs, and native app directory structure. Two minor items flagged: (1) ambiguity in the exact Expo Router group for the unauthenticated redeem screen, and (2) unable to fully count all 14 wallet-lane rows in the ledger due to tool limits (found 2 of the route/exclusion rows; the registry WALLET.* rows were not reached). No blockers or majors found.

## Findings

### R1-F1 [minor]

The plan says the native RedeemVoucher screen will be placed in 'the public app/redeem.tsx route segment, not under app/(app)/' but does not specify whether it goes in the existing (public) layout group (app/(public)/redeem.tsx) or as a bare top-level file (app/redeem.tsx). These are different: (public) routes get the PublicLayout Stack (headerShown: false), while a bare top-level file gets only the root _layout.tsx. Both are unauthenticated, but the shell chrome and navigation behavior differ. The plan should be explicit about which group the file belongs to.

- `exafyltd/vitana-v1:apps/mobile/app/(public)/_layout.tsx:1` — /** VTID-05186 (N3, plan change 14) — public auth routes: no shell chrome (web bottom-nav hide list). */
import { Stack } from 'expo-router';

export default function PublicLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
- `exafyltd/vitana-v1:apps/mobile/app` — Directory listing shows both (app) and (public) groups plus top-level files (index.tsx, _layout.tsx, etc.)

Suggestion: Specify explicitly: 'app/(public)/redeem.tsx' (inherits the no-chrome public Stack layout matching the web's public-route presentation) or 'app/redeem.tsx' (top-level, root layout only). The (public) group seems like the natural home since the web's /redeem sits in the same 'Public Routes - No Auth Required' block as /reset-password and /logout, both of which are already in (public).

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
