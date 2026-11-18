# Design — Native shell fixes (native-shell-fixes-r2)

## 1. The gateway path contract
`createGatewayFetch` (`packages/core/src/gateway.ts:19-33`) computes `api = gatewayApiUrl(origin)` once
(`gateway.ts:22`); `gatewayApiUrl` strips a trailing `/api/v1` from the origin and appends `/api/v1`
(`packages/core/src/config.ts:21-24`). Each call fetches `${api}${rel}` (`gateway.ts:31`). The native shell client
is this function with `endpoints(config).gatewayOrigin` (`apps/mobile/src/auth/gateway.ts:14`), and `gatewayGet`
passes the caller's path through (`gateway.ts:23-25`). So shell callers pass the path after `/api/v1`.

Fix 1: `useMyPartnerOrgs.ts:23` → `gatewayGet<…>('/partner-orgs/mine')`.
Fix 2: `GuidedModeProvider.tsx:71` → `gatewayGet<…>('/journey/state')`.

## 2. The commerce sign-in redirect
Web: `getLoginRoute()` returns `'/commerce/join'` when the path starts with `/commerce`
(`src/components/AuthGuard.tsx:65`), and the guard navigates to `${loginRoute}?redirectTo=${encodeURIComponent(intended)}`
(`AuthGuard.tsx:204`). `/commerce` is `allowGuest` (`src/App.tsx:1831`) so only deeper paths reach that branch.

Native fix 3 replaces the single redirect at `AuthGate.tsx:46` with a target chosen by path:
```tsx
const signIn = pathname.startsWith('/commerce/') ? '/commerce/join' : '/maxina';
return <Redirect href={`${signIn}?redirectTo=${encodeURIComponent(href)}` as never} />;
```
`isGuestPath(pathname)` (`AuthGate.tsx:45`) still runs first, so `/commerce` keeps the guest shell. The header comment
(`AuthGate.tsx:3`) is updated to name both targets. No redirect loop: `/commerce/join` is a `(public)` route (§3),
so `(app)/_layout.tsx` and its `AuthGate` never render for it.

## 3. Public commerce route mounts
Thin files in the public group, each the pattern PR #1587 already uses:
```tsx
import { CommerceJoinScreen } from '../../../src/screens/business/CommerceJoinScreen';
export default function CommerceJoinRoute() { return <CommerceJoinScreen />; }
```
| Route file | Component (from #1587) | Web route |
|---|---|---|
| `app/(public)/commerce/join.tsx` | `CommerceJoinScreen` | `src/App.tsx:1830` |
| `app/(public)/commerce-login.tsx` | `CommercePortalLoginScreen` | `/commerce-login` |
| `app/(public)/commerce/connect/index.tsx` | `CommerceConnectDocsScreen` | `src/App.tsx:1855` |
| `app/(public)/commerce/connect/privacy.tsx` | `CommerceConnectPrivacyScreen` (in `CommerceConnectDocsScreen.tsx`) | `src/App.tsx:1856` |

The lane also adds `'/commerce-login'`, `'/commerce/connect'`, `'/commerce/connect/privacy'` and `'/commerce/join'`
to `NATIVE_ROUTES` in `apps/mobile/src/navigation/resolve.ts`, because `tests/navigation.test.tsx:67-84` keeps that
list equal to the route files on disk (sparring s2 R1-F1). Only after #1587 merged; no entry without its file.

The `(public)` and `(app)` groups both hold a `commerce` folder; Expo Router allows that as long as no two files
resolve to the same URL, and the business lane's `(app)/commerce/**` files cover different URLs.

## 4. Tests
- `tests/shell-fixes/gateway-paths.test.tsx`: `__setGatewayForTests(createGatewayFetch({ origin: 'https://gw.test',
  getAccessToken: () => 't', fetchImpl }))` where `fetchImpl` records the URL and returns a 200 JSON body. Renders
  `useMyPartnerOrgs` and `GuidedModeProvider` with the existing `makeWrapper` double and asserts the recorded URLs
  equal `https://gw.test/api/v1/partner-orgs/mine` and `https://gw.test/api/v1/journey/state`.
- `tests/shell-fixes/auth-gate.test.tsx`: mocks `expo-router` (`usePathname`, `useGlobalSearchParams`, `Redirect`
  recording `href`) and asserts the three cases of plan "Test plan".
- `tests/shell-fixes/commerce-routes.test.tsx`: mocks the business screen modules and asserts each route renders its
  component.
- Red on base is recorded in `docs/validation/<VTID>/red-on-base.txt` (the route test fails on base for a missing
  file; that test is new behaviour, the other two are red for the bug itself).
