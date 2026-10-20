# Tasks — native-g1-wiring

One PR per lane (`kiro/native-g1-wiring/<lane-id>`, except `build-profiles` which is
`claude/native-g1-wiring/build-profiles`; title `VTID-xxxxx (native-g1-wiring/<lane-id>): …`, trailers
`Collab-Session` / `Collab-Lane`). A lane changes only its `paths` (Lane scope). VTIDs are assigned by CI
after PLAN-SPAR converges; do not start a lane before its `vtid:` is set. Every lane: `cd apps/mobile`
then `npm ci`, `npm test`, `npm run typecheck`; add `docs/validation/<VTID>/{scope.json,
staging-tests.json,plan-sparring.md}` (read-only); keep `@vitana/core`-only, 11 locales + RTL (DE first),
`ReactElement` not `JSX`. No What's New entry (no new finished member feature; configuration/test work).

## Env values per profile — R1
<!-- lane: env-profiles -->
- [ ] E1 Add `apps/mobile/env/development.json` (empty) and `apps/mobile/env/test-g1.example.json`
  (G1 **placeholder** hosts only — a documented non-resolving value, never a real/production/staging
  host). Document the key set (`gatewayUrl`, `supabaseUrl`, `dataApiUrl?`, `authRedirectUrl`,
  `webBaseUrl`, `supabasePublishableKey`, `googleWebClientId`, `googleIosClientId` — the keys in
  `src/config/env.ts:62` `URL_KEYS`/`VALUE_KEYS`).
- [ ] E2 In `apps/mobile/src/config/env.ts`, add a profile loader that reads the active `APP_PROFILE`'s
  JSON (via `expo-constants` `extra.profile` or `process.env.APP_PROFILE`), overlays any set
  `EXPO_PUBLIC_*`, and feeds the existing `loadConfig` (`env.ts:189`). Do not change `assertNotProduction`,
  `assertNotProductionKey`, `ConfigMissingError`, `URL_KEYS`, `VALUE_KEYS`, or add any default URL.
- [ ] E3 `apps/mobile/tests/env.test.ts` (extend): `development` → `{}`; `test-g1` placeholder set loads
  and every URL passes `assertNotProduction`; a production host or the production publishable key in a
  profile throws; a missing required `test-g1` value yields `ConfigMissingError` naming the keys.
- [ ] E4 Verify: `cd apps/mobile && npm test` (env + app-config suites), `npm run typecheck`,
  `APP_PROFILE=development npm run bundle` and `APP_PROFILE=test-g1 npm run bundle` succeed offline. Add
  `docs/validation/<VTID>/staging-tests.json` (read-only shell nav only).

## Build profiles — R2 (governance path → executor claude)
<!-- lane: build-profiles -->
- [ ] B1 Add `apps/mobile/eas.json` with `development` and `test-g1` build profiles that set
  `APP_PROFILE` and declare the `EXPO_PUBLIC_*` env mapping to the §2 source; no `production` profile; no
  Expo token, store credential, Firebase/`google-services` file or signing config. Mark build entries
  internal / no-credential (EAS cloud builds wait for G3 — `native-eas-builds` plan).
- [ ] B2 In `.github/workflows/NATIVE-CI.yml`, add an offline (`EXPO_OFFLINE=1`), secret-free step/matrix
  that bundles both profiles (`APP_PROFILE=development|test-g1 npm run bundle`) and asserts the `test-g1`
  bundle contains no production/staging host string (reuse the probe check idea from
  `apps/mobile/probe/check-probe.js`). Do not add required-check status or any token.
- [ ] B3 Verify: NATIVE-CI runs green on the PR; both bundles build offline; the host-string assertion
  passes. Add `docs/validation/<VTID>/staging-tests.json` (read-only). PR notes this is the only
  governance-path lane (`.github/**`).

## Fixture gateway harness — R3
<!-- lane: fixture-gateway -->
- [ ] F1 Add `apps/mobile/tools/fixture-gateway/{server.js,cli.js,server.d.ts}` (plain CommonJS, bind
  `127.0.0.1` by default / private LAN with an explicit flag, listen-only, no outbound connection —
  mirror `tools/orb-fake-gateway/server.js:17`). Routes: `GET /api/v1/app-config` (body accepted by
  `parseAppConfigResponse`, `remote-config.ts:120`, flags/min-version togglable per scenario),
  `GET /api/v1/auth/me` (signed-in member fixture, status togglable to 401),
  `POST /api/v1/notifications/token` (records token + `device_type`, answers ok),
  `GET /.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` for the `.dev`
  identifiers (`app.config.ts:IDENTIFIERS`). Record every request for assertions.
- [ ] F2 `apps/mobile/tests/fixture-gateway/server.test.ts`: each route answers the expected shape; the
  `app-config` body passes `parseAppConfigResponse`; `auth/me` 401 scenario; the fixture binds only to
  loopback/private and refuses any other bind address.
- [ ] F3 Verify: `cd apps/mobile && npm test` (fixture suite), `npm run typecheck`. Add
  `docs/validation/<VTID>/staging-tests.json` (read-only).

## Deep-link + push smoke against the fixture — R4
<!-- lane: deep-link-push-smoke -->
- [ ] D1 Add `apps/mobile/src/push/g1-test-provider.ts` — a `PushProvider` (port in
  `src/push/provider.ts:14`) returning a fixed token and letting a test fire `onOpen`/foreground
  messages; installed only via `setPushProvider` inside tests, never in a real build. No Firebase
  package.
- [ ] D2 `apps/mobile/tests/g1-smoke/remote-config.smoke.test.ts` — point a `test-g1`-shaped config's
  `gatewayUrl` at a running fixture (`127.0.0.1`, not a blocked host); assert `source: 'remote'`,
  `push_enabled` true; a second scenario asserts `updateRequired` from a high `min_supported_version`.
- [ ] D3 `apps/mobile/tests/g1-smoke/push.smoke.test.ts` — install `G1TestPushProvider`, run
  `src/push/registration.ts` so the token is POSTed to the fixture (`/notifications/token` recorded);
  fire `onOpen({ data: { url: '/comm/groups/123' } })` and assert `resolveLink`
  (`src/linking/resolve-link.ts`) returns that route.
- [ ] D4 `apps/mobile/tests/g1-smoke/deep-link.smoke.test.ts` — every `LINK_PATHS` entry
  (`app.config.ts`: `/auth/confirmed`, `/reset-password`, `/oauth/complete`, `/i/:code`) resolves through
  `resolveLink` / `link-router`; auth/invite links go through `auth-port`.
- [ ] D5 Guard test: `NoopPushProvider` is the default provider; `G1TestPushProvider` is only ever set
  inside tests (extend `tests/push-registration.test.ts` or a new `tests/g1-smoke/guard.test.ts`).
- [ ] D6 Verify: `cd apps/mobile && npm test` (g1-smoke suite green), `npm run typecheck`. Add
  `docs/validation/<VTID>/staging-tests.json` (read-only). State in the PR that this proves the Wave 1
  exit path (navigate shell + push + deep link) against the **fixture**, with real-G1 gated on
  `real-g1-switch`.

## The owner-gated real-G1 switch — R5 (depends-on-owner, next_actor owner)
<!-- lane: real-g1-switch -->
- [ ] G1 Add `apps/mobile/env/test-g1.g1.example.json` documenting the **shape** of the real G1 inputs
  (keys only; values `<provided-by-owner>` placeholders; never real values committed).
- [ ] G2 Add `docs/validation/g1/README.md`: the switch procedure — set the `test-g1` profile to the
  owner-provided real G1 Supabase + Aurora-proxy endpoints, re-run the `deep-link-push-smoke` suite
  against real G1, record the result. `assertNotProduction` still gates every URL; never production or
  staging.
- [ ] G3 **Owner gate (do not start until the owner provisions G1).** When G1 exists: point the `test-g1`
  build at the real G1 endpoints, run the smoke against real G1 on both platforms (signed-in member
  navigates the shell, receives a push, opens its deep link — program §5 Wave 1 exit,
  `NATIVE-APP-PLAN.md:214`), and record the evidence in `docs/validation/g1/`. This step keeps
  `next_actor: owner` until the owner acts.

## Wave 1 exit (coordinator, no lane)
- [ ] The four buildable lanes merged and green; the fixture smoke proves navigate + push + deep link
  offline. The real-G1 proof (`real-g1-switch` G3) is recorded once the owner provisions G1 — the Wave 1
  exit criterion is met on real G1 only then.
