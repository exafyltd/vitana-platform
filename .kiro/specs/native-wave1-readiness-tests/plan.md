# Plan — native-wave1-readiness-tests
Author: Kiro, seat `exafyltd`. Repos: `exafyltd/vitana-v1` (native app `apps/mobile/`; all four lanes) and
`exafyltd/vitana-platform` (this spec only). Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), Wave 1
row at `vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md:196`. Spec: `handoff.md`, `tasks.md`, `lanes/*.md` in this folder.

<!-- plan:begin -->
## Goal
Owner instruction (2026-11-10), verbatim: "Wave 1 readiness, with no G1 required: unit and integration tests against mocks for auth, roles, push, deep links, and i18n in all 11 languages. Mark any test that needs G1 as skipped with a note, and do not count it toward the exit."

This plan adds **new test files only** to `apps/mobile/tests/wave1-readiness/<area>/`. It changes no source file, no existing
test, no existing helper, no test key and no dependency (owner rule for this run). The tests are **readiness evidence only**.
They do not prove the Wave 1 exit, which is "signed-in G1 member navigates the full shell in all modes, receives a push and
opens its deep link, on both platforms" (`vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md:196`) and needs the isolated
test environment G1 (`:100`, §5). A case that needs G1 is written as `it.skip` and is not counted toward the exit.

## Measured state
Pinned: vitana-v1 origin/main e31bf4627ff3c705c20f8e6b718ce4dd03353b7f, vitana-platform origin/main 6dc6e1ba0c18252ec2f3fbf5651d245e200f9835 (2026-11-10T16:53Z).
All paths are `vitana-v1:apps/mobile/...` read with `git show <sha>:<path>`; counts are `it(`/`test(`/`it.each(` lines.

Existing coverage per area (so the lanes add only gaps). Jest runs `tests/**/*.test.ts(x)` (`jest.config.js`: `roots: ['<rootDir>/tests']`, `testMatch`), so a new `tests/wave1-readiness/**` folder is picked up with no config change. `tests/wave1-readiness/` does not exist at the pin.

| Area | Existing test files (count of cases) |
|---|---|
| auth | `tests/auth.test.tsx` (14), `tests/auth/confirm-links.test.tsx` (13), `tests/auth/oauth-reset-logout.test.tsx` (12), `tests/auth/portals.test.tsx` (15), `tests/auth/i18n-rtl.test.tsx` (10), `tests/portal.test.tsx` (3), `tests/secure-storage.test.ts` (10), `tests/link-bridge.test.tsx` (4): 81 |
| roles | `tests/core/roles.test.ts` (4), `tests/identity.test.tsx` (10: tenant, role preference, role switch), `tests/shell-logic.test.ts` (route guard table `:182-198`, 12 rows; role-switch destinations `:201`): 14 + the two shell-logic blocks |
| push | `tests/push-registration.test.ts` (18), `tests/g1-smoke/push.test.ts` (5, over the loopback fixture `tools/fixture-gateway`), `tests/g1-smoke/noop-default.test.ts`: 23+ |
| deep links | `tests/resolve-link.test.ts` (29, incl. the link router and N3 port stub), `tests/g1-smoke/deep-link.test.ts` (5), `tests/auth/confirm-links.test.tsx` (3 resolve cases), `tests/home/deep-links.test.tsx` (7), `tests/audiobook/deeplink-reminder.test.tsx` (12): 56 |
| i18n / RTL | `tests/i18n.test.ts` (5: 11 locales, `common.loading`, fallback to `de`, only `ar` RTL, generated map lists every shard on disk), `tests/i18n-rtl.test.tsx` (3, shell and drawer in each of the 11 locales), `tests/language.test.tsx` (5), plus 30 per-screen `*i18n*` files |
| helpers (import only) | `tests/helpers/providers.tsx` (`fakeGateway`, `makeWrapper`), `tests/helpers/supabase-double.ts` (`createSupabaseDouble`, `fakeSession`), `tests/helpers/mocks.ts`, `tests/helpers/no-network.ts` |

**Gaps** (symbols with no reference in any test file at the pin, found with `git grep` over `apps/mobile/tests`; the lane re-checks each one before writing):
- **auth:** `AuthGate` (`src/shell/AuthGate.tsx:36`) is only exercised incidentally by `delete-account/delete-account.test.tsx` and `wallet-redeem/route-gate-i18n.test.tsx`; `isGuestPath` (`:19`) and `useCurrentHref` (`:24`) have no test; `oauthErrorKey` (`src/auth/sign-in.ts:69`), `SignInTimeoutError` (`:43`), `emailRedirectFor` (`:87`), `resetRedirect` (`:92`) and `resendConfirmation` (`:142`) have no test; `CONFIRMATION_ERROR_KEYS` (`src/auth/post-confirm.ts:23`) is not checked against the catalogs; `gatewayGet` (`src/auth/gateway.ts:23`) has no test.
- **roles:** `ROLE_LABEL_KEY` / `roleLabel` (`src/shell/logic/role-labels.ts:7`, `:18`) have no test and are not checked in 11 locales; `isWebConsoleDestination` (`src/identity/useRoleSwitch.ts:26`) has no test; `useRole` (`src/identity/useRole.ts:13`) is covered by `identity.test.tsx:72-91` for the optimistic update, rollback and the `role.changed` payloads, but nothing asserts the `NO_ACTIVE_TENANT` answer with no RPC (`useRole.ts:29`), the `community` default when the stored preference is null (`:43`) or the success path (`:39-40`); `routeGuard` (`src/shell/logic/route-guard.ts:17`) has a 12-row table at `shell-logic.test.ts:182-198` (6 of the 8 roles: no `developer` or `infra`; 8 of the 11 community prefixes never appear, and no `/staff` or `/professional` path is asserted for `community`).
- **push:** `usePushLifecycle` (`src/push/registration.ts:205`: token-refresh re-register, badge sync on sign-in and on return to foreground, cleanup) has no test; `PUSH_TIMEOUT_MS` (`:30`) has no test; `onTokenRefresh` has no test; the push-open path of `useLinkRouting` (`src/linking/link-router.ts:113`: cold-start `getInitialOpen`, live `onOpen`, cleanup) has no test; `createG1TestPushProvider` (`src/push/g1-test-provider.ts:75`) is only used over the loopback fixture, never with an injected `fetchImpl`.
- **deeplinks-i18n:** `useLinkRouting` (session replay and cleanup) and `configuredLinkHosts` (`src/linking/link-router.ts:89`) have no test; `localeFromDevice` (`src/i18n/index.ts`) has no test; nothing checks, across the whole composed catalog, that each of the 11 locales has the same shard file set, that placeholders (`{name}`) match `de`, and that `de` carries no Sie/Ihr/Ihnen; `tests/i18n.test.ts:37` checks only that the generated map lists the shards on disk.

## Premise evidence (vitana-v1, pinned e31bf4627ff3c705c20f8e6b718ce4dd03353b7f)
The sparring partner reads only vitana-platform, so the vitana-v1 premises the lanes rest on are quoted here (`git show <sha>:<path>`), and every lane re-checks them first (task 0).
- `apps/mobile/jest.config.js`: `roots: ['<rootDir>/tests']`, `testMatch: ['**/*.test.ts', '**/*.test.tsx']`, `preset: 'jest-expo'`.
- `apps/mobile/package.json`: `"test": "jest"`, `"typecheck": "tsc --noEmit"`.
- `apps/mobile/tests/helpers/providers.tsx`: `export function fakeGateway(routes)` (`:24`), `export function makeWrapper(opts)` (`:34`); `supabase-double.ts`: `export function fakeSession` (`:16`), `export function createSupabaseDouble` (`:25`); `mocks.ts` and `no-network.ts` are `export {}` side-effect files.
- `src/i18n/index.ts:16` `export const LOCALES = ['de','en','es','sr','fr','pl','pt','ru','tr','zh','ar'] as const`; `:40` `export function isRTL`; `:68` `export function localeFromDevice`; `RTL_LOCALES` is `new Set(['ar'])`.
- `src/shell/AuthGate.tsx:19` `export function isGuestPath(path)`, `:24` `useCurrentHref`, `:36` `AuthGate({ member, guest })`; signed-out member path returns `<Redirect href={`/maxina?redirectTo=${encodeURIComponent(href)}`}>` (`:46`); a bounce returns `<Redirect href={bounce}>` (`:50`).
- `src/shell/logic/route-guard.ts:17` `export function routeGuard(path, dbRole, reg)`; `:10` `COMMUNITY_PREFIXES` (11 entries); `:31` backoffice always returns `/home`.
- `src/identity/useRole.ts:29` `if (!activeTenantId) return { ok: false, error: 'NO_ACTIVE_TENANT' }`; `:43` `const dbRole: UserRole = (query.data as UserRole | null) || 'community'`.
- `src/push/registration.ts:30` `PUSH_TIMEOUT_MS = 10000`; `:205` `usePushLifecycle` subscribes `onTokenRefresh`, `subscribeSession` and `AppState` `change`; `:108` posts `{ fcm_token, device_type, app_version }`.
- `src/push/g1-test-provider.ts:75` `createG1TestPushProvider(config)` with `fetchImpl` defaulting to global `fetch`; posts `{ token, device_type }`.
- `src/linking/link-router.ts:89` `configuredLinkHosts`, `:113` `useLinkRouting` (cold start `getInitialOpen`, `onOpen`, `subscribeSession` replay).

## Decisions (each decided by Kiro, grounded in the cited code)
1. **Four lanes, one per area with a gap, each owning one new folder.** `auth`, `roles`, `push`, `deeplinks-i18n`, folders `apps/mobile/tests/wave1-readiness/{auth,roles,push,deeplinks-i18n}/`. Reason: disjoint paths, so the lanes run in parallel with no shared file.
2. **New files only.** No edit to an existing test, helper, mock or config; no `jest.mock` factory is added to a shared file. Each new file declares its own `jest.mock(...)` calls and imports `tests/helpers/**` read-only. Reason: owner rule for this run.
3. **Only assert behaviour that holds on main today.** A test records current behaviour (`file:line` in a comment). If a candidate assertion fails on the pinned main because the source differs from the web contract, the test is **not** weakened and the source is **not** changed: the lane records the divergence in `docs/validation/<VTID>/acceptance.md` as a finding with `file:line` and leaves the case out. Reason: no source change is allowed and a red test must not be merged.
4. **G1-dependent cases are `it.skip`, never deleted and never counted.** Each is written `it.skip('<name>', ...)` with the comment `// needs G1 (isolated test backend): <reason>` on the line above, and listed in the lane's `docs/validation/<VTID>/acceptance.md` under "Skipped, needs G1 (NOT counted toward the Wave 1 exit)". The Wave 1 exit evidence (`NATIVE-APP-PLAN.md:196`) is not claimed by any lane.
5. **Mocks only; no network.** Gateway calls go through `fakeGateway`/`makeWrapper` or an injected `fetchImpl`; Supabase through `createSupabaseDouble`. No test starts `tools/fixture-gateway` (that is the G1 smoke's job, `tests/g1-smoke/helpers.ts`), none opens a socket, none names a production host. The existing `tests/helpers/no-network.ts` guard stays active.
6. **i18n covers all 11 locales (de en es sr fr pl pt ru tr zh ar), RTL for `ar`.** Locale lists come from `LOCALES` (`src/i18n/index.ts:16`), never retyped. `ar` is asserted RTL and the other ten LTR through `isRTL` (`:40`).
7. **No dependency, no `package.json`/lockfile change, no `.github/**`, no `scripts/collab/**`.** Lanes are `executor: kiro` with the reviewer agent.

## Lanes
| Lane | Repo | Executor / seat → reviewer | Scope | depends_on | next_actor |
|---|---|---|---|---|---|
| `auth` | vitana-v1 | kiro / exafyltd → vitana-lane-reviewer | `apps/mobile/tests/wave1-readiness/auth/**`, `docs/validation/VTID-*/{acceptance.md,commands.log,scope.json,staging-tests.json,plan-sparring.md}` | — | kiro |
| `roles` | vitana-v1 | same | `apps/mobile/tests/wave1-readiness/roles/**`, same docs globs | — | kiro |
| `push` | vitana-v1 | same | `apps/mobile/tests/wave1-readiness/push/**`, same docs globs | — | kiro |
| `deeplinks-i18n` | vitana-v1 | same | `apps/mobile/tests/wave1-readiness/deeplinks-i18n/**`, same docs globs | — | kiro |

The `docs/validation/VTID-*/...` globs are the per-lane evidence files that every lane PR carries under its own VTID
(`land-guard.mjs:31` `EVIDENCE_FILES`, enforced at `:38-41`: `acceptance.md`, `commands.log`, `scope.json`); they are the `docs/validation/**` part of each lane and are the
same shape as the merged `native-wave3-release-r2/lanes/crash-port.md`. No two lanes share a test file. **Parallelism:** all four
lanes run at once (up to 4 of the cap 6). No hot file (`App.tsx`, `screens.json`, ledger, migrations, i18n shards) is touched.

## Tests and verification
- Each lane: `cd apps/mobile && npm ci && npm test && npm run typecheck`. `npm test` runs the whole suite, so the lane also proves it broke nothing.
- Red on base: every new test file is absent on `origin/main`, so `npx jest tests/wave1-readiness/<area>` finds no tests there (Jest exits non-zero with "No tests found"); the lane records that run in `commands.log` as the base result. The bundle is unaffected (tests are not bundled), so the offline-bundle check of the Wave 3 plan is not needed; the lane records `git diff --stat origin/main` showing only the declared paths.
- Not verified on staging for any lane: the tests run offline against mocks, no member-visible surface changes, and nothing is deployed.
- No lane writes to any live system; nothing runs against production or staging.

## Out of scope / owner-gated (not built here)
- **G1** isolated test backend (`NATIVE-APP-PLAN.md:100`): real sign-in/refresh/sign-out, real role grants, a real token row in the backend, push over the fixture with a real identity provider, and the Wave 1 exit itself. Written only as counted-out `it.skip` cases.
- **G2** Firebase / APNs and FCM delivery (real device tokens, real push delivery), **G3** store/signing, any vendor or SDK choice, the IAP decision, a Mac, real devices.
- Any source change (including fixing a divergence a test exposes), any edit to an existing test or helper, any change to `scripts/collab/**`, `.kiro/steering/**`, `CLAUDE.md`, lane-scope or lane-path rules.

## Measurement
Per lane, `docs/validation/<VTID>/acceptance.md` reports: cases added (running), cases skipped for G1 (not counted), findings
recorded under decision 3. The Wave 1 exit count stays at what G1-based evidence provides; these tests add 0 to it.
<!-- plan:end -->
