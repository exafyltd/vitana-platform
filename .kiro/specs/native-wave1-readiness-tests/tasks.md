# Tasks — native-wave1-readiness-tests

One PR per lane, all in `exafyltd/vitana-v1`. Branch `kiro/native-wave1-readiness-tests/<lane-id>`, title
`VTID-xxxxx (native-wave1-readiness-tests/<lane-id>): …`, trailers `Collab-Session` and `Collab-Lane`. A lane changes only
its `paths`: **new test files** under its folder plus its `docs/validation/<VTID>/` evidence. VTIDs are assigned by CI after
PLAN-SPAR converges; do not start a lane before its `vtid:` is set. Every lane: `cd apps/mobile && npm ci && npm test && npm run typecheck`.

**Rules for every lane (plan decisions 2–5).** No edit to an existing test, helper, mock, config or source file; no test key
changed; no dependency. Import `tests/helpers/**` and `src/**` only. Declare `jest.mock(...)` inside the new file. Mocks only:
no network, no fixture-gateway, no production host. Before writing a case, `git grep` its subject in `apps/mobile/tests` on
current `origin/main`; if an existing test already asserts it, leave it out. Assert only what holds on main; a source
divergence from the web contract is recorded as a finding in `acceptance.md`, not asserted and not fixed. A case that
needs G1 is `it.skip('<name>', ...)` with the line above it `// needs G1 (isolated test backend): <reason>`, listed in
`acceptance.md` under "Skipped, needs G1 (NOT counted toward the Wave 1 exit)".

**Task 0 (every lane, before any test file).** Re-check every premise the lane's cases rest on against `origin/main` of vitana-v1: the file exists, the cited symbol and line, the helper export names, and `jest.config.js` `roots`/`testMatch`; record the result and the checked SHA in `commands.log`. If a premise is stale, adapt the case to what main does now and note it in `acceptance.md`; if a case's subject is gone, drop the case and say so. Never edit source to make a premise true.

**Readiness statement (every lane's `acceptance.md` opens with it).** These tests are readiness evidence only. They do not
prove the Wave 1 exit ("signed-in G1 member navigates the full shell in all modes, receives a push and opens its deep link, on
both platforms", `NATIVE-APP-PLAN.md:196`), which needs G1 (`NATIVE-APP-PLAN.md` §5, §2a). Skipped cases are not counted
toward the exit, and neither are the passing ones.

## Auth
<!-- lane: auth -->
- [ ] A1 `tests/wave1-readiness/auth/sign-in-helpers.test.ts`: `oauthErrorKey` (timed out, Apple cancel/expired, anything else, a string, an object with `message`, `undefined`), `SignInTimeoutError` (name, message, `instanceof Error`), `SIGN_IN_DEADLINE_MS`, `emailRedirectFor` for `maxina`, `alkalma` and an unknown slug, `resetRedirect`, trailing slashes on `authRedirectUrl` trimmed, and a missing `authRedirectUrl` throwing the config-missing error (never a production link).
- [ ] A2 `tests/wave1-readiness/auth/resend-confirmation.test.ts`: `resendConfirmation` against `createSupabaseDouble`: success, an error answer, the tenant's confirmation redirect.
- [ ] A3 `tests/wave1-readiness/auth/auth-gate.test.tsx`: `isGuestPath` table (every `GUEST_PATHS` entry matches, a member path does not); `AuthGate` with `expo-router` and the auth, role and tenant hooks mocked in the file: loading shows the loader and neither child; signed out on a guest path renders `guest`; signed out on a member path redirects to `/maxina?redirectTo=<encoded href>` with the query kept and the catch-all `path` param dropped; signed in renders `member`; signed in with a bouncing `routeGuard` result redirects; role still loading renders `member` without a bounce.
- [ ] A4 `tests/wave1-readiness/auth/gateway-get.test.ts`: `gatewayGet` through `__setGatewayForTests`: path forwarded, JSON returned, an error propagates, reset to the default with `null`.
- [ ] A5 `tests/wave1-readiness/auth/confirm-keys-i18n.test.ts`: every `CONFIRMATION_ERROR_KEYS` value and every key returned by `oauthErrorKey` resolves to real text (not the key) in each of the 11 locales from `LOCALES`.
- [ ] A6 Skips (each `it.skip` + `// needs G1 (isolated test backend): <reason>`): password sign-in against the G1 identity provider; a session surviving an app restart; token refresh on expiry against the G1 identity provider; sign-out revoking the server session; Apple and Google sign-in end to end.
- [ ] A7 `docs/validation/<VTID>/{acceptance.md,commands.log,scope.json}` per the template below.

Acceptance:
- Change types: Tooling/docs (new test files only)
- Outcome: none for members; the auth surface has mock-level regression cover for the helpers and the gate that had none.
- States: signed out, loading, signed in, role loading, guest path, member path, timeout, cancel.
- Surfaces: n/a: no screen changes.
- Locales: A5 asserts the auth error keys in all 11 locales (de en es sr fr pl pt ru tr zh ar).
- Accessibility: n/a: no UI change.
- Contract: no source file changed (`git diff --stat origin/main` lists only `apps/mobile/tests/wave1-readiness/auth/**` and `docs/validation/<VTID>/`); no existing test or helper edited; no `package.json` change.
- Readiness only: `acceptance.md` opens with the readiness statement; the G1 skips (A6) are listed as NOT counted toward the Wave 1 exit; these tests do not prove the Wave 1 exit, which needs G1.
- Staging proof: not verified on staging: offline mock tests, nothing deployed; the covering evidence is the new tests and a green `npm test`.
- Red on base: `npx jest tests/wave1-readiness/auth` on `origin/main` finds no tests (recorded in `commands.log`).

## Roles
<!-- lane: roles -->
- [ ] R1 `tests/wave1-readiness/roles/role-labels.test.ts`: `ROLE_LABEL_KEY` has an entry for every role in `ROLE_LADDER`; `roleLabel` returns the translation for each role in each of the 11 locales (non-empty, not the key); an unknown role returns the role string.
- [ ] R2 `tests/wave1-readiness/roles/route-guard-matrix.test.ts`: `routeGuard` over all 8 roles × one path per group (every community prefix, `/admin`, `/staff`, `/professional`, `/patient`, `/backoffice`, each shared path, the consumer path, `/admin/device-preview`, a tenant-portal path), written as a table of the values current main returns; rows already in `shell-logic.test.ts:182-198` are left out.
- [ ] R3 `tests/wave1-readiness/roles/web-console-destination.test.ts`: `isWebConsoleDestination` for `/admin`, `/admin/x`, an external destination, `/home`, `/patient/dashboard`, `/administrator` (no false prefix match); and `getRoleSwitchDestination` is never external for the roles `computeAvailableRoles` returns on mobile, for all 8 roles.
- [ ] R4 `tests/wave1-readiness/roles/use-role.test.tsx`: `useRole` with `makeWrapper` and `createSupabaseDouble`: no active tenant → `setRole` answers `{ ok: false, error: 'NO_ACTIVE_TENANT' }` and no `set_role_preference` RPC runs; `dbRole` is `community` when `get_role_preference` returns null or an empty list; success path returns `{ ok: true }` and re-reads the preference; a `get_role_preference` error leaves `dbRole` `community`.
- [ ] R5 Skips: role grants read from the G1 database (`get_my_permitted_roles` on real rows); a role switch persisted and read back after a restart; a staff/admin member's web-console hand-off to a real host.
- [ ] R6 `docs/validation/<VTID>/{acceptance.md,commands.log,scope.json}`.

Acceptance:
- Change types: Tooling/docs (new test files only)
- Outcome: none for members; role labels in 11 locales, the full route-guard matrix and the `useRole` edge cases have mock-level cover.
- States: every `UserRole`, no tenant, null preference, RPC error, success.
- Surfaces: n/a: no screen changes.
- Locales: R1 asserts the role labels in all 11 locales (de en es sr fr pl pt ru tr zh ar).
- Accessibility: n/a: no UI change.
- Contract: no source file changed; no existing test or helper edited; no `package.json` change; R2 is a table of current behaviour, each row with its `route-guard.ts` line in a comment, and any row where main differs from the web contract is a recorded finding, not an assertion.
- Readiness only: `acceptance.md` opens with the readiness statement; the G1 skips (R5) are NOT counted toward the Wave 1 exit; these tests do not prove the Wave 1 exit, which needs G1.
- Staging proof: not verified on staging: offline mock tests, nothing deployed.
- Red on base: `npx jest tests/wave1-readiness/roles` on `origin/main` finds no tests.

## Push
<!-- lane: push -->
- [ ] P1 `tests/wave1-readiness/push/push-lifecycle.test.tsx`: `usePushLifecycle` mounted with `setPushProvider(fake)` and `setPushClient(fake)`: a provider token refresh calls `registerPushToken(session, token)`; a session change to non-null calls `syncBadge`, to null does not; `AppState` `change` to `active` syncs the badge, to `background` does not; unmount unsubscribes all three (no call after unmount). Singletons are reset with `setPushProvider(NoopPushProvider)` and `setPushClient(null)` in `afterEach`.
- [ ] P2 `tests/wave1-readiness/push/push-timeout.test.ts`: with an injected `fetchImpl` that never resolves and a short `timeoutMs`, `registerPushToken`, `unregisterPushToken` and `syncBadge` return `{ status: 'error' }` and never throw; `PUSH_TIMEOUT_MS` is 10000.
- [ ] P3 `tests/wave1-readiness/push/push-open-routing.test.tsx`: `useLinkRouting` with a fake provider: a cold-start `getInitialOpen` with `data.url` navigates via the attached navigator; a live `onOpen` navigates; an `open_link_url` fallback navigates; a foreign-host or unusable payload opens home and never the link; a `getInitialOpen` rejection is swallowed; a push open while signed out is held and replayed after sign-in; unmount removes the listeners. (Router and session store are mocked in the file.)
- [ ] P4 `tests/wave1-readiness/push/g1-test-provider.test.ts`: `createG1TestPushProvider` with an injected `fetchImpl` (no fixture, no socket): default token and `ios`, the `android` override, `isAvailable` true, `getToken`, `pushOpen(url)` shape, `registerToken` POST path, bearer header and JSON body, a non-JSON body answered as `null`, and the timeout path.
- [ ] P5 Skips: a token POST recorded by the G1 test backend; a notification delivered by APNs or FCM to a device (also G2); badge count read from the G1 backend for a real member.
- [ ] P6 `docs/validation/<VTID>/{acceptance.md,commands.log,scope.json}`.

Acceptance:
- Change types: Tooling/docs (new test files only)
- Outcome: none for members; the push lifecycle, the timeout and the push-open path have mock-level cover.
- States: provider unavailable (Noop), token refresh, signed in/out, foreground/background, timeout, cold start, live open, foreign host.
- Surfaces: n/a: no screen changes.
- Locales: n/a: no user-visible text.
- Accessibility: n/a: no UI change.
- Contract: no source file changed; no existing test or helper edited; no `package.json` change; P4 pins the body the test provider posts (`token`, `device_type`) as it is today and records in `acceptance.md` that `createPushClient` posts `fcm_token` (`src/push/registration.ts:108`), as an observation, not a fix.
- Readiness only: `acceptance.md` opens with the readiness statement; the G1 skips (P5) are NOT counted toward the Wave 1 exit; these tests do not prove the Wave 1 exit ("receives a push"), which needs G1.
- Staging proof: not verified on staging: offline mock tests, nothing deployed.
- Red on base: `npx jest tests/wave1-readiness/push` on `origin/main` finds no tests.

## Deep links and i18n
<!-- lane: deeplinks-i18n -->
- [ ] L1 `tests/wave1-readiness/deeplinks-i18n/link-hosts.test.ts`: `configuredLinkHosts` with `expo-constants` mocked in the file: no `extra.linkHosts` → `[]`; an array with non-strings → strings only; a non-array → `[]`. A link on a configured host resolves, one on an unconfigured host opens home.
- [ ] L2 `tests/wave1-readiness/deeplinks-i18n/link-routing-session.test.tsx`: `useLinkRouting` replays a held route target after the session signal turns non-null and detaches on unmount (the push-open half is lane `push`, P3, so the two lanes share no case).
- [ ] L3 `tests/wave1-readiness/deeplinks-i18n/catalog-parity.test.ts`: over `catalogs` from `src/i18n`, for each of the 11 locales: the same shard file set as `de` (`SHARD_FILES`); every placeholder `{name}` in a `de` value present in the same key of each other locale where the key exists; no value empty. The test asserts only the invariants that hold on main at build time; a divergence is listed in `acceptance.md` as a finding (locale, key) and left out.
- [ ] L4 `tests/wave1-readiness/deeplinks-i18n/de-du-form.test.ts`: no `Sie`/`Ihr`/`Ihnen` as a word in the composed `de` catalog (CLAUDE.md "Catalog quality").
- [ ] L5 `tests/wave1-readiness/deeplinks-i18n/rtl-locales.test.tsx`: for each of the 11 locales, `I18nProvider` with `initialLocale` sets the direction (`ar` RTL, others LTR) through `isRTL`/`I18nManager` mocked in the file, and `translate` falls back to `de` for an unknown locale; `localeFromDevice` returns the first shipped device language, else `de` (`expo-localization` mocked in the file).
- [ ] L6 Skips: a universal link on the real associated domain opening the app (the web host does not exist before G1, `src/linking/link-router.ts:88`); an `apple-app-site-association` / `assetlinks.json` served and verified; a deep link opened on a signed-in G1 member.
- [ ] L7 `docs/validation/<VTID>/{acceptance.md,commands.log,scope.json}`.

Acceptance:
- Change types: Tooling/docs (new test files only)
- Outcome: none for members; link hosts, the router's session replay and the whole-catalog parity of the 11 locales have mock-level cover.
- States: no hosts, configured host, foreign host, signed out then in, unmount; each of the 11 locales; `ar` RTL.
- Surfaces: n/a: no screen changes.
- Locales: L3, L5 run over all 11 locales (de en es sr fr pl pt ru tr zh ar); L4 asserts `de` is du-form.
- Accessibility: n/a: no UI change; RTL direction is asserted for `ar` in L5.
- Contract: no source file changed; no existing test, helper or i18n shard edited; no `package.json` change; findings from L3 are recorded, not fixed.
- Readiness only: `acceptance.md` opens with the readiness statement; the G1 skips (L6) are NOT counted toward the Wave 1 exit; these tests do not prove the Wave 1 exit ("opens its deep link"), which needs G1.
- Staging proof: not verified on staging: offline mock tests, nothing deployed.
- Red on base: `npx jest tests/wave1-readiness/deeplinks-i18n` on `origin/main` finds no tests.

## Evidence template (all lanes, A7/R6/P6/L7)
`acceptance.md`: readiness statement; cases added; "Skipped, needs G1 (NOT counted toward the Wave 1 exit)" with each skipped
name and reason; findings (source differs from the web contract: `file:line`, what main does); the checklist items above. `commands.log`: the
red-on-base run, `npm test`, `npm run typecheck`, `git diff --stat origin/main`. `scope.json`: the lane's paths.
