---
change_class: standard
---
# Plan — native-shell-fixes
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only: `apps/mobile/**` and `docs/validation/**`;
no web screen, no backend, no gateway change, no migration, no `packages/core` change). Spec: `requirements.md`,
`design.md`, `tasks.md`, `lanes/shell-fixes.md` in this folder. Program: `docs/programs/native-app/program.md`
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, VTID-05021).

<!-- plan:begin -->
## Goal
Fix three bugs in the native app shell that reviewers of native Wave 2 lanes found, and mount the four public
commerce routes the business lane's screens need. Two shell reads call the gateway with a doubled `/api/v1` prefix,
so business modes and the guided journey mode never load on a device. Signed-out users who open a `/commerce/*`
link land on the community sign-in instead of the supplier front door the web sends them to. Owner instruction:
"continue, what are you waiting for" (driver session `kiro-exafyltd-202611011658-9f52`, which holds the
`native-shell-fixes/_plan` claim).

## Today (vitana-v1 origin/main `aac65bfeb`)
- **Gateway prefix.** `apps/mobile/src/auth/gateway.ts:14` builds the shell client with `createGatewayFetch`
  (`packages/core/src/gateway.ts:19`). That function sets `api = gatewayApiUrl(origin)` (`gateway.ts:22`), and
  `gatewayApiUrl` returns `${base}/api/v1` after stripping any trailing `/api/v1` from the origin
  (`packages/core/src/config.ts:21-24`). Every request goes to `${api}${path}` (`packages/core/src/gateway.ts:31`).
  A caller must therefore pass the path after `/api/v1`.
- **Bug 1.** `apps/mobile/src/identity/useMyPartnerOrgs.ts:23` calls `gatewayGet('/api/v1/partner-orgs/mine')`, so
  the request goes to `<origin>/api/v1/api/v1/partner-orgs/mine`, answers 404, and business modes never appear.
- **Bug 2.** `apps/mobile/src/identity/GuidedModeProvider.tsx:71` calls `gatewayGet('/api/v1/journey/state')`, so
  the request goes to `<origin>/api/v1/api/v1/journey/state`, fails, and the provider falls back to `full` mode
  (`GuidedModeProvider.tsx:77-79`).
- **Why tests did not catch it.** The shared fake gateway (`apps/mobile/tests/helpers/providers.tsx:24-31`) replaces
  the whole `GatewayFetch` and matches the path argument, before any prefixing. `apps/mobile/tests/identity.test.tsx:149`
  keys its fixture on `'/api/v1/partner-orgs/mine'`, so it encodes the bug and turns red once bug 1 is fixed.
- **Bug 3.** `apps/mobile/src/shell/AuthGate.tsx:46` sends every signed-out user on a non-guest path to
  `/maxina?redirectTo=<path>`. The web `AuthGuard` returns `/commerce/join` as the login route for any path starting
  with `/commerce` (`src/components/AuthGuard.tsx:65`) and navigates to `${loginRoute}?redirectTo=<path>`
  (`AuthGuard.tsx:204`). `/commerce/join` is the public supplier onboarding route (`src/App.tsx:1830`); the comment
  at `src/App.tsx:1851-1853` states that a signed-out supplier goes through `/commerce/join` and back. `/commerce`
  itself is a guest path on both sides (`src/App.tsx:1831` `allowGuest`; `apps/mobile/src/navigation/guest-paths.ts:14`).
- **Native `/commerce/join` route.** It is not on main: no file under `apps/mobile/app/` matches `commerce`, and the
  ledger row `/commerce/join` is `lane: role-modes`, `status: not_started` (`apps/mobile/parity/ledger.json:4433-4440`).
  The screen components come from the business lane, vitana-v1 PR #1587 (VTID-05524,
  `kiro/native-wave2-role-modes-r2/business`, open): `apps/mobile/src/screens/business/CommerceJoinScreen.tsx`,
  `CommercePortalLoginScreen.tsx`, `CommerceConnectDocsScreen.tsx` (exports `CommerceConnectDocsScreen` and
  `CommerceConnectPrivacyScreen`). That PR also adds four `apps/mobile/app/(public)/` route files, but the business
  lane's `paths` cover only `apps/mobile/app/(app)/commerce/**` and `apps/mobile/app/(app)/commerce-login.tsx`, so
  the driver moved those four public route files into this lane.

## Decisions
1. **One lane, `shell-fixes`.** Each change is one line or a thin route file. The three shell files are not touched
   by any open vitana-v1 PR (checked against every open PR's file list on 2026-11-03).
2. **Fixes 1 and 2:** pass `'/partner-orgs/mine'` and `'/journey/state'`. No change to `createGatewayFetch` or
   `gatewayApiUrl`; the core contract is right and other callers rely on it.
3. **Fix 3:** in `AuthGate`, a signed-out user on a non-guest path that starts with `/commerce/` goes to
   `/commerce/join?redirectTo=<encoded path + query>`; every other path keeps `/maxina?redirectTo=…`. `/commerce`
   stays a guest path and is matched before this branch. Under the vitana-v1 Commerce UX contract this brings
   supplier friction to web parity; it adds no step.
4. **Public commerce routes:** the lane creates `apps/mobile/app/(public)/commerce/join.tsx`,
   `(public)/commerce-login.tsx`, `(public)/commerce/connect/index.tsx` and `(public)/commerce/connect/privacy.tsx`,
   each a thin default-export mount of the business lane's screen component, with no logic. They live in the public
   group because the web routes have no `AuthGuard` (`src/App.tsx:1830`, `:1855-1856`).
5. **Order: PR #1587 lands first.** The four route files import screens that only exist after #1587, and fix 3
   needs `/commerce/join` to resolve to a real public screen. Fixes 1 and 2 have no such dependency but ship in the
   same PR. `depends_on: []` because the dependency is on another plan's lane; the lane log records it and the lane
   does not open its PR before #1587 merges. #1587 drops its own `(public)` route files before it merges (driver
   decision; those files are outside its Lane scope). **Fallback:** if #1587 is closed without merging, the lane
   drops the four route files and the commerce branch of fix 3, keeps today's `/maxina` redirect for every path,
   ships fixes 1 and 2, and logs it.
6. **The existing fixture is corrected, not deleted.** `apps/mobile/tests/identity.test.tsx:149` changes its key to
   `'/partner-orgs/mine'` (quality-checks "a move or rename greps every test"). That file is in the lane's `paths`
   for this one line.

## Lanes
| Lane | Seat → reviewer | Scope | depends_on |
|---|---|---|---|
| `shell-fixes` | exafyltd → agent:vitana-lane-reviewer | fixes 1–3, four public commerce route mounts, red-first tests | — (waits for vitana-v1 #1587, decision 5) |

Exact `paths` are in `lanes/shell-fixes.md`. Shared files: none. Hot files: none (no open PR touches the three shell
files or `tests/identity.test.tsx`).

## Test plan
- **Red first, offline.** New tests under `apps/mobile/tests/shell-fixes/`:
  - partner orgs and journey state: install a real `createGatewayFetch` with origin `https://gw.test` and a fake
    `fetchImpl` through `__setGatewayForTests` (`apps/mobile/src/auth/gateway.ts:19`), render the hook / provider,
    and assert the exact URL `https://gw.test/api/v1/partner-orgs/mine` and `https://gw.test/api/v1/journey/state`.
    Red on base: the recorded URL has `/api/v1/api/v1/`.
  - AuthGate: signed out on `/commerce/team` → `<Redirect>` to `/commerce/join?redirectTo=%2Fcommerce%2Fteam`; signed
    out on `/home` → `/maxina?redirectTo=%2Fhome` (unchanged); signed out on `/commerce` → guest shell (unchanged).
    Red on base: the commerce case redirects to `/maxina`.
  - route mounts: each of the four route files renders its business screen component (mocked module).
- From `apps/mobile/`: `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`.
- `docs/validation/<VTID>/staging-tests.json` lists only `npm run X` / `npx jest P` refs (e.g. `npx jest tests/shell-fixes`,
  `npm run typecheck`).
- **Staging proof:** not verified on staging, because the native app has no staging deploy and device runtime waits
  for G1 (`next_actor: owner`). The tests above cover the outcome.

## Risks
- If #1587 merges with its own `(public)` route files, this lane's route task becomes a no-op on files it does not
  own; the lane then logs that and does not edit them.
- Ledger rows for the four routes belong to the business lane; this lane does not flip them.

## Unchanged
`packages/core/**`, `apps/mobile/src/auth/gateway.ts`, `guest-paths.ts`, the web app, the parity ledger, i18n
catalogs, every other redirect target.
<!-- plan:end -->
