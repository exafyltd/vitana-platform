# Sparring round 1 — in_progress

Session: `bb8b09d5-b6ca-45a7-be71-52f17e443da3` · plan hash `f5b8b9ceff50e0d9b279fe5ea5915496bad2774a6fb84eaf6235e494c4e1f02f`

## Summary

All three bugs described in the plan are confirmed against the pinned code: the doubled `/api/v1` prefix in `useMyPartnerOrgs.ts:23` and `GuidedModeProvider.tsx:71`, and the missing commerce-specific redirect in `AuthGate.tsx:46`. The web parity claims about `AuthGuard.tsx:65` (`/commerce` → `/commerce/join`) and the public nature of `/commerce/join`, `/commerce/connect`, and `/commerce/connect/privacy` on the web (App.tsx:1830, 1855–1856) all hold. The `(public)` layout correctly bypasses AuthGate, so the new route files will be accessible without auth. One significant gap: adding four new route files to `(public)` will break the existing navigation test that enforces `NATIVE_ROUTES` matches the files on disk, and the plan does not account for updating that list.

## Findings

### R1-F1 [major]

Adding four new route files under `apps/mobile/app/(public)/` without updating `NATIVE_ROUTES` in `resolve.ts` will break `tests/navigation.test.ts`. The comment at resolve.ts:37–41 states the test keeps `NATIVE_ROUTES` equal to the route files on disk. Existing `(public)` routes like `/maxina`, `/alkalma`, `/privacy`, `/terms` are already in the list (resolve.ts:49, 92, 113, 143). The four new commerce paths (`/commerce/join`, `/commerce-login`, `/commerce/connect`, `/commerce/connect/privacy`) are absent, and `resolve.ts` is implicitly unchanged per the plan.

- `exafyltd/vitana-v1:apps/mobile/src/navigation/resolve.ts:37` — /**
 * Concrete native route files (app/**, groups stripped). tests/navigation.test.ts
 * keeps this list equal to the files on disk. `/native-ui-catalogue` is N2's
 * dev-only kit catalogue (VTID-05176, ledger `native_only`).
 */
export const NATIVE_ROUTES: readonly string[] = [
  '/',
  '/ai',
  '/ai/companion',
  '/ai/daily-summary',
  '/ai/insights',
  '/ai/recommendations',
  '/alkalma',
- `exafyltd/vitana-v1:apps/mobile/src/navigation/resolve.ts:88` —     '/intents/board',
    '/intents/mine',
    '/logout',
    '/maxina',
    '/maxina/confirmed',
    '/maxina_support',
    '/me/matches',
    '/me/profile',
- `exafyltd/vitana-v1:apps/mobile/src/navigation/resolve.ts:110` —     '/privacy',
    ...
    '/terms',
    '/wallet',
    '/wallet/balance',
    '/wallet/rewards',
    '/wallet/subscriptions',
  ];

Suggestion: Add the four new public route paths to `NATIVE_ROUTES` in `resolve.ts` and include `resolve.ts` in the lane's `paths`. Alternatively, confirm with the navigation test that (public) files are enumerated separately — but the existing (public) routes already appear in NATIVE_ROUTES so this is almost certainly required.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
