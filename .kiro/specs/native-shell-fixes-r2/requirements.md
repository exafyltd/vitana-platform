# Requirements — Native shell fixes (native-shell-fixes-r2)

Three bugs in the native app shell (`exafyltd/vitana-v1` `apps/mobile/`), found by reviewers of native Wave 2 lanes,
plus the four public commerce route mounts the driver moved here from the business lane. Measured on vitana-v1
`origin/main` `aac65bfeb`. Fake-gateway / fixture tests only; no live system.

## R0 — Scope
0.1 One lane, `shell-fixes`. It changes only the files in `lanes/shell-fixes.md` `paths`.
0.2 The lane opens its PR only after vitana-v1 PR #1587 (VTID-05524, business lane) has merged (plan decision 5).
0.3 If #1587 closes without merging, R3 falls back to today's behaviour and R4 is dropped (plan decision 5).

## R1 — Partner orgs request path
1.1 `useMyPartnerOrgs` (`apps/mobile/src/identity/useMyPartnerOrgs.ts:23`) requests
`<gateway origin>/api/v1/partner-orgs/mine`, exactly once per query, by passing `'/partner-orgs/mine'` to
`gatewayGet`.
1.2 The fixture key in `apps/mobile/tests/identity.test.tsx:149` becomes `'/partner-orgs/mine'`; the test keeps its
assertions.

## R2 — Journey state request path
2.1 `GuidedModeProvider` (`apps/mobile/src/identity/GuidedModeProvider.tsx:71`) requests
`<gateway origin>/api/v1/journey/state` by passing `'/journey/state'` to `gatewayGet`. Cache and fallback behaviour
(`GuidedModeProvider.tsx:64-79`) is unchanged.

## R3 — Signed-out commerce redirect
3.1 Signed out, on a non-guest path starting with `/commerce/`: `AuthGate` redirects to
`/commerce/join?redirectTo=<encodeURIComponent(path + query)>`, matching web `src/components/AuthGuard.tsx:65` and
`:204`.
3.2 Signed out, any other non-guest path: `/maxina?redirectTo=<encoded>` as today (`AuthGate.tsx:46`).
3.3 Guest paths (`apps/mobile/src/navigation/guest-paths.ts`, including `/commerce`) still render the guest shell.
3.4 Signed-in behaviour (`AuthGate.tsx:48-52`) is unchanged.

## R4 — Public commerce route mounts
4.1 `apps/mobile/app/(public)/commerce/join.tsx` renders `CommerceJoinScreen`;
`(public)/commerce-login.tsx` renders `CommercePortalLoginScreen`; `(public)/commerce/connect/index.tsx` renders
`CommerceConnectDocsScreen`; `(public)/commerce/connect/privacy.tsx` renders `CommerceConnectPrivacyScreen`. All
four import from `apps/mobile/src/screens/business/` (added by #1587) and hold no logic.
4.2 The four paths are added to `NATIVE_ROUTES` in `apps/mobile/src/navigation/resolve.ts` together with their files,
so `tests/navigation.test.tsx` ("NATIVE_ROUTES equals the concrete route files in app/") stays green.

## R5 — Verification and safety
5.1 Each fix has a test under `apps/mobile/tests/shell-fixes/` that is red on `origin/main` for the bug it fixes and
green after.
5.2 From `apps/mobile/`: `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle` green.
5.3 `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (refs only `npm run X` / `npx jest P`),
`red-on-base.txt` and `plan-sparring.md`.
5.4 Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS write, or a test against
production. The native app has no production profile.

## Out of scope
`packages/core/**` (the `/api/v1` prefix contract is correct), `apps/mobile/src/auth/gateway.ts`, the web app, the
parity ledger (business lane owns the commerce rows), i18n catalogs, any other redirect target.
