# J - Push notification splash screen delay (session_01UnhfZmnjjej1XS8rBqxrBZ)
- Created 2026-10-14 07:45, updated 08:08 UTC; idle, completed. Branch claude/adoring-ptolemy-a0rlsw (both repos); no commits seen.

## Goal
Reduce the delay/splash seen when tapping a push notification to open a chat in the mobile app.

## Done
- Analysis only, no code changed ("I haven't changed any code yet"). No PRs/VTIDs seen.
- Finding: production mobile app is an Appilix web-view wrapper, not apps/mobile (push off, dev only). Splash is Appilix's native splash, set in the Appilix dashboard; no splash code in repo.
- Delay chain on web side: index.html no-cache, bundle + lazy chunk, AuthProvider session check, AuthGuard full-screen spinner (AuthGuard.tsx:224), ProtectedRoute loader, then Messages. Android background taps may land on wrong screen then jump (App.tsx:586-633, 300ms-3.2s). One extra reload at AuthProvider.tsx:548-551 on identity mismatch. Gateway sends open_link_url to Appilix (notification-service.ts:593-619).
- Last reply to owner: steps to turn off/shorten splash in Appilix, match its background colour, rebuild; native splash may still show on notification cold starts (session did web searches for Appilix settings; exact UI steps not verified by me).

## State now
- Nothing open, no uncommitted work known. No deploy.

## Blocked on / needs owner
- Owner does the Appilix dashboard change + rebuild. Owner wanted splash only on app entry/login (not notification opens); a plan for web-side speedups was proposed but not approved.

## Next steps for Kiro
1. Optionally plan (spar first, then VTID) web-side speedups: lighter auth-guard loader on notification deep links, skip DelayedLoader/auth wait where cached session valid, review the reload at AuthProvider.tsx:548-551 and the Android navigation timing in App.tsx.
2. Full removal of native splash is only possible with the real native app (apps/mobile), not in production yet.
3. All design through plan(...) PR; merge/prod are Claude Code/PM.

## Gotchas/lessons
- Do not claim the splash is fixable from this repo; it is Appilix-side.
- Cannot test notification flows against production (absolute no-prod-test rule).
