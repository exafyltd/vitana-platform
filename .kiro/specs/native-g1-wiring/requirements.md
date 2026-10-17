# Requirements — Point dev/QA native builds at the G1 test backend (native-g1-wiring)

Wave 1 exit for the native Maxina app (program VTID-05021,
`docs/programs/native-app/NATIVE-APP-PLAN.md`). The Wave 1 exit criterion is: a signed-in G1 member
navigates the full shell in all modes, receives a push and opens its deep link, on both platforms
(`docs/programs/native-app/NATIVE-APP-PLAN.md:214` §5 Wave 1 row). This plan builds the configuration
and verification scaffolding that lets a build be pointed at the G1 test backend, and proves the
push/deep-link path end to end against a local fixture gateway — because the real G1 backend does not
exist yet.

## The hard constraint this whole plan is built around

The G1 isolated test environment (a test Supabase project for auth/Realtime/Storage + an Aurora test
cluster behind the `postgrest-aurora` proxy) is an **owner-only gate that does not exist yet**
(`.kiro/specs/health-native/handoff.md:52` "Waiting on the owner" #4 lists G1/0T among the owner's
items; program §2a "G1 Isolated test environment",
`docs/programs/native-app/NATIVE-APP-PLAN.md:95`). Therefore:

- **Built now (this plan's exit criterion):** the per-profile env/build-profile scaffolding, a local
  **fixture gateway** that speaks the shell/push/deep-link contract, and a fixture smoke path that
  proves a signed-in member navigates the shell, receives a push and opens its deep link — all against
  the fixture, with no network call to any real host.
- **Gated on the owner (does not run in this plan):** switching a real build to the real G1 Supabase +
  Aurora-proxy endpoints. That step is `depends-on-owner`, `next_actor: owner`, and never points any
  build at production or staging (both share the production database — root `CLAUDE.md` "Why no host is
  exempt"; `apps/mobile/src/config/env.ts:9`).

## R1 — Env values per profile (lane `env-profiles`)

1.1 Each build profile (`development`, `test-g1`) resolves its endpoint set from a committed,
non-secret, **non-production** source rather than only ambient `process.env.EXPO_PUBLIC_*`
(`apps/mobile/src/config/env.ts:230` reads `process.env` directly today). `development` stays fully
unset (no network); `test-g1` resolves from a committed example/placeholder set whose hosts are G1
placeholders, never a real host.
1.2 Every URL still passes `assertNotProduction` and every key `assertNotProductionKey`
(`apps/mobile/src/config/env.ts:82`, `:105`): a production or staging host, or the production
publishable key, fails the build/test. The `blocked-hosts` list is unchanged
(`apps/mobile/src/config/blocked-hosts.js:24`).
1.3 A `test-g1` build that is missing a required value renders the existing `ConfigMissing` path
(`apps/mobile/src/config/env.ts:49` `ConfigMissingError`, listing the missing keys), never a default.
1.4 No new endpoint, no default URL, and no change to `URL_KEYS`/`VALUE_KEYS`
(`apps/mobile/src/config/env.ts:62`).

## R2 — Build profiles (lane `build-profiles`, governance path → executor claude)

2.1 A declarative build-profile file (`apps/mobile/eas.json`, or the local-runner equivalent the plan
decides) defines `development` and `test-g1` profiles that set `APP_PROFILE` and the `EXPO_PUBLIC_*`
inputs; no `production` profile exists (mirrors `app.config.ts` which throws on `production`,
`apps/mobile/app.config.ts:36`).
2.2 No EAS token, no store credential, no Firebase/`google-services` file, no signing — those wait for
G2/G3 (`apps/mobile/README.md` "What waits for which gate"). The profiles only parameterise a JS
bundle / prebuild that already runs offline in CI.
2.3 The NATIVE-CI job that bundles per profile stays offline (`EXPO_OFFLINE=1`) and secret-free, like
the existing jobs (`.github/workflows/NATIVE-CI.yml` header). A `test-g1` bundle built in CI uses only
the committed placeholder env and still makes no network call.
2.4 This is the only lane that edits a governance path (`.github/**`); per collaboration §3a it is
`executor: claude`, `reviewer_seat: claude`.

## R3 — Fixture gateway harness (lane `fixture-gateway`)

3.1 A local **fixture gateway** (`apps/mobile/tools/fixture-gateway/`), separate from the ORB fake
gateway (`apps/mobile/tools/orb-fake-gateway/`, which only speaks the ORB WS/SSE voice protocol,
`server.js:1`), answers the HTTP contract the shell/push/deep-link path uses: `GET /api/v1/app-config`
(the shape `parseAppConfigResponse` validates, `apps/mobile/src/config/remote-config.ts:120`),
`GET /api/v1/auth/me`, `POST /api/v1/notifications/token`, and serves AASA / `assetlinks.json` for the
`.dev` identifiers so associated-domain / App-Link resolution can be exercised.
3.2 Same network limits as the ORB fake: binds to `127.0.0.1` (or a private-range LAN address with an
explicit flag), listens only, opens no outbound connection
(`apps/mobile/tools/orb-fake-gateway/server.js:17`).
3.3 The fixture's `app-config` response can toggle `push_enabled` and `orb_native_enabled` so the smoke
path can assert both flag states; its body validates against the real client
(`parseAppConfigResponse`).

## R4 — Deep-link + push smoke against the fixture (lane `deep-link-push-smoke`)

4.1 A fixture-only smoke proves: (a) a signed-in member (fixture `auth/me`) reaches the shell and the
remote-config client reports `source: 'remote'` with `push_enabled` on; (b) a simulated push `data.url`
resolves through `resolveLink` (`apps/mobile/src/linking/resolve-link.ts`) to the correct route;
(c) a universal/App-Link path (`/i/:code`, `/auth/confirmed`, `/reset-password`, `/oauth/complete` —
`app.config.ts:LINK_PATHS`) resolves through the same resolver.
4.2 A test `PushProvider` (the port already supports injection — `setPushProvider`,
`apps/mobile/src/push/provider.ts:52`) stands in for FCM, since FCM waits for G2. No Firebase package is
added.
4.3 The Maestro device journeys that drive this on real devices against G1 stay `apps/mobile/maestro/`
only-on-G1 (`apps/mobile/maestro/shell/10-deep-link-admin.yaml`, README "Device journeys"); this lane
adds the **offline/fixture** Jest + RN Testing Library path that runs in CI, not a production/staging
spec.
4.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` entry; for the fixture lanes
these are read-only shell navigations only (no write), consistent with the staging gate
(program §6, `docs/programs/native-app/NATIVE-APP-PLAN.md:233`).

## R5 — The owner-gated real-G1 switch (lane `real-g1-switch`, depends-on-owner, next_actor owner)

5.1 This lane carries the single step that points a `test-g1` build at the **real** G1 Supabase project
+ Aurora proxy endpoints, and runs the fixture smoke (R4) against the real G1 instead of the fixture.
5.2 It is blocked until the owner provisions G1 (program §2a; handoff "Waiting on the owner" #4). Its
front matter is `next_actor: owner`; it stays `ready` and is not started by any Kiro/Claude session
until the owner marks G1 available.
5.3 It never points a build at production or staging (`assertNotProduction` still gates every URL). The
real G1 endpoints are supplied by the owner as `test-g1` profile inputs; this lane changes only how the
`test-g1` profile is fed and records the result, no new endpoint keys.

## R6 — Repo-wide rules every lane honours

6.1 Never test against production; staging specs read-only; no write to a live system
(root `CLAUDE.md`; collaboration §7a).
6.2 11 locales (ar de en es fr pl pt ru sr tr zh) + RTL, DE shard first; any new user-visible string
goes to `src/i18n/de/` first (`apps/mobile/README.md` "i18n"). This plan prefers existing keys; a new
key is a web deploy path.
6.3 React 19 types: no global `JSX` namespace — use `ReactElement`
(`.kiro/specs/health-native/handoff.md:88`).
6.4 Native code reaches web code only through `@vitana/core` / `@vitana/tokens`
(`packages/core/manifest.json:2`; `apps/mobile/README.md` "Web code").
6.5 No new page is added to `app/`, so no `screens.json` / `exclusions.json` / `screen-manifest` /
parity-ledger row is required by this plan. If a lane were to add a member-visible `app/` route it would
have to add all four (program §4, root rule "Voice navigation — the screen registry" /
"Native parity ledger"); none does.

## Measured state (origin/main, worktree `nat-g1-wiring-plan`)

- Parity ledger `apps/mobile/parity/ledger.json` version 2: **435 route rows** (428 `not_started`,
  5 `in_progress`, 2 `exception`), **15 shell entries** (all `in_progress`, owner `N3 VTID-05186`),
  4 `native_only` entries (`apps/mobile/parity/ledger.json:1`, measured by
  `node -e` over the file).
- Wave 1 screens that already exist: the N3 shell (`apps/mobile/src/shell/`, 15 shell components in the
  ledger) and the N2 UI kit (`apps/mobile/src/ui/`, `@vitana/ui`); the two member portal routes
  `/maxina` and `/alkalma` are `in_progress` (`AUTH.MAXINA_PORTAL`, `AUTH.ALKALMA_PORTAL` rows). All
  screen `rows` are `not_started` — Wave 2 has not started.
- Env/push/links scaffolding already present: `apps/mobile/src/config/env.ts`, `blocked-hosts.js`,
  `remote-config.ts`, `http.ts`, `kv-store.ts`, `version.ts`; `src/push/{provider,registration}.ts`;
  `src/linking/{resolve-link,link-router,auth-port}.ts`; `app.config.ts` with `APP_PROFILE`
  development/test-g1. No `eas.json` exists yet (`git ls-files` found none).

## Out of scope (owner / later plans)

- Provisioning G1 itself (owner, program §2a / handoff #4).
- G2 push backend / Firebase project and the real FCM provider (N4-FCM, after G2).
- G3 store/signing access and EAS cloud builds with credentials.
- Any Wave 2 screen port (own sparred plan per area).
