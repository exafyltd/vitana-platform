# Design — native-g1-wiring

Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (frontend/native only; the one governance-path
lane edits `.github/**` and `apps/mobile/eas.json` and is `executor: claude`). Spec: `requirements.md`,
`tasks.md`, `plan.md`, `lanes/*.md`. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (Wave 1 exit,
§5 row at `:214`).

This is a configuration-and-verification plan. It writes **no product screen** and adds **no `app/`
route**, so no `screens.json` / `screen-manifest` / parity-ledger change is required (R6.5). It extends
the already-built Wave 1 config/push/links machinery (`src/config/env.ts`, `remote-config.ts`,
`src/push/`, `src/linking/`) with: a per-profile env source, declarative build profiles, a local fixture
gateway, a fixture smoke path, and the owner-gated real-G1 switch.

## §1 Why these five lanes, and why disjoint

The work splits along file ownership so no two lanes touch one file:

| Lane | Owns (globs) | Executor | Why separate |
|---|---|---|---|
| `env-profiles` | `apps/mobile/src/config/env.ts`, `apps/mobile/env/**`, `apps/mobile/tests/env*.ts` | kiro | pure app-code: how a profile's values reach `loadConfig` |
| `build-profiles` | `apps/mobile/eas.json`, `.github/workflows/NATIVE-CI.yml` | **claude** | edits a governance path (`.github/**`); kept alone so only it is claude-executed (collaboration §3a) |
| `fixture-gateway` | `apps/mobile/tools/fixture-gateway/**`, `apps/mobile/tests/fixture-gateway/**` | kiro | a new local server, no app-code change |
| `deep-link-push-smoke` | `apps/mobile/tests/g1-smoke/**`, `apps/mobile/src/push/g1-test-provider.ts` | kiro | the smoke test + a test-only push provider |
| `real-g1-switch` | `apps/mobile/env/test-g1.g1.example.json`, `docs/validation/g1/**` | kiro, **next_actor owner** | the single owner-gated step; its own files so the four buildable lanes never wait on it |

Dependency order: `env-profiles` first (the others import the profile source); `fixture-gateway` is
independent of `env-profiles` for its own code but the smoke lane needs both; `deep-link-push-smoke`
depends on `env-profiles` + `fixture-gateway`; `real-g1-switch` depends on `deep-link-push-smoke` and on
the owner. `build-profiles` depends on `env-profiles` (it feeds the env source into the bundle).

## §2 Env values per profile (R1)

Today `src/config/env.ts:230` builds `config` directly from `process.env.EXPO_PUBLIC_*`. The design adds
a thin, explicit profile source without changing the guards:

- `apps/mobile/env/` holds `development.json` (empty — no network) and `test-g1.example.json` (G1
  **placeholder** hosts only, e.g. a documented non-resolving `*.g1.invalid`/`127.0.0.1` style value, so
  CI and local dev never reach a real host and `assertNotProduction` passes). Real G1 values are supplied
  by the owner at build time (R5), never committed.
- A small loader (`apps/mobile/src/config/env.ts`, same file) reads the profile's JSON for the active
  `APP_PROFILE`, overlaid by any `EXPO_PUBLIC_*` actually set, then calls the existing `loadConfig`
  (`env.ts:189`). The guards (`assertNotProduction`, `assertNotProductionKey`, `ConfigMissingError`) are
  untouched; a bad host still throws.
- No new key, no default URL (R1.4). `development` resolves to `{}` exactly as today.

## §3 Build profiles (R2) — EAS vs local, decided

**Decision: use `apps/mobile/eas.json` as the declarative profile file, and keep CI bundling through the
existing offline Metro bundle, not an EAS cloud build.** Reason: `eas.json` is the standard Expo
build-profile format and is where real EAS/TestFlight builds (the later `native-eas-builds` plan, handoff
backlog) will attach; defining `development` + `test-g1` profiles now is forward-compatible and costs no
credential. But EAS **cloud** builds need an Expo token + store/signing (G3), so this plan does not run
one — the NATIVE-CI job keeps using `APP_PROFILE=<p> npm run bundle` offline (`README.md` "Run it"),
reading the §2 env source. `eas.json` here only records the profile→env mapping and `APP_PROFILE`; its
`build` entries are marked internal/no-credential. (Rejected: inventing a bespoke local-only profile file
— it would be thrown away when `native-eas-builds` adds `eas.json` anyway.)

The NATIVE-CI change adds a matrix step that bundles both profiles offline and asserts the `test-g1`
bundle contains no production/staging host string (reusing the probe idea from
`apps/mobile/probe/check-probe.js`). This touches `.github/workflows/NATIVE-CI.yml` → governance path →
the whole lane is `executor: claude` (R2.4).

## §4 Fixture gateway (R3)

`apps/mobile/tools/fixture-gateway/server.js` (+ `cli.js`, `.d.ts`), modelled on the ORB fake
(`tools/orb-fake-gateway/server.js`): plain CommonJS, binds `127.0.0.1` by default, listen-only. Routes:

- `GET /api/v1/app-config` → a body that `parseAppConfigResponse` accepts
  (`remote-config.ts:120`): `{ ok: true, schema_version: 1, ttl_seconds, platforms: { ios, android } }`
  with per-platform `flags` and `min_supported_version`. Scenarios flip `push_enabled`,
  `orb_native_enabled`, and `min_supported_version` (to exercise `updateRequired`).
- `GET /api/v1/auth/me` → a signed-in member fixture (status togglable to 401 for the signed-out branch).
- `POST /api/v1/notifications/token` → records the token+`device_type` and answers ok, so push
  registration (`src/push/registration.ts`) can be driven without FCM.
- `GET /.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` → documents for the
  `.dev` identifiers (`com.exafy.maxina.dev` / `com.vitanaland.app.dev`, `app.config.ts:IDENTIFIERS`), so
  App-Link association can be exercised against the fixture host.

It records every request (method, path, body shape) so tests assert the client's calls. It never speaks
the ORB WS/SSE protocol — that stays the ORB fake's job (no overlap).

## §5 Deep-link + push smoke (R4)

`apps/mobile/tests/g1-smoke/` Jest + RN Testing Library, pointed at a fixture-gateway instance via a
`test-g1`-shaped config whose `gatewayUrl` is the fixture's `127.0.0.1` address (a loopback address is not
a blocked host, so `assertNotProduction` passes):

- `g1-smoke/remote-config.smoke.test.ts` — client fetches `/app-config`, `source: 'remote'`,
  `push_enabled` true; a second scenario asserts `updateRequired` from a high `min_supported_version`.
- `g1-smoke/push.smoke.test.ts` — a `G1TestPushProvider` (`src/push/g1-test-provider.ts`, installed via
  `setPushProvider`, `provider.ts:52`) returns a token; `src/push/registration.ts` posts it to the
  fixture; a simulated `onOpen({ data: { url: '/comm/groups/123' } })` resolves through `resolveLink`
  (`src/linking/resolve-link.ts`) to that route.
- `g1-smoke/deep-link.smoke.test.ts` — each `LINK_PATHS` entry (`/auth/confirmed`, `/reset-password`,
  `/oauth/complete`, `/i/:code` — `app.config.ts:LINK_PATHS`) resolves through `resolveLink` /
  `link-router` to the expected target (auth/invite links go through `auth-port`).

The `G1TestPushProvider` lives in `src/push/` (not `tools/`) because it implements the `PushProvider`
port and is installed at runtime in the smoke; it is dev/test-only and never installed in a real build
(a guard test asserts `NoopPushProvider` is the default and the test provider is only set inside tests).

## §6 The owner-gated real-G1 switch (R5)

`real-g1-switch` carries one step and its own files so the four buildable lanes never block on it:

- `apps/mobile/env/test-g1.g1.example.json` documents the **shape** of the real G1 inputs (keys only,
  values are `<provided-by-owner>` placeholders) so the owner knows exactly what to supply; the real
  values are never committed.
- `docs/validation/g1/README.md` records the switch procedure: set the `test-g1` profile inputs to the
  owner-provided real G1 Supabase + Aurora-proxy endpoints, run the §5 smoke against real G1, record the
  result. `assertNotProduction` still gates every URL.
- Front matter `next_actor: owner`, `depends_on: [deep-link-push-smoke]`. It stays `ready`; no Kiro/Claude
  session starts it. When the owner provisions G1 they (or a session the owner directs) flip it forward.

## §7 i18n, types, @vitana/core (R6)

No new user-visible string is required (the smoke and fixtures are developer-facing). If a lane finds it
must add one, it goes to `src/i18n/de/` first, then mirrored, 11 locales, RTL-safe (`README.md` "i18n").
All TS uses `ReactElement`, never the global `JSX` namespace. App code imports web code only through
`@vitana/core`/`@vitana/tokens`; the fixture gateway and smoke import neither web `src/` directly nor the
web Supabase/gateway clients (ESLint already bans those in `apps/mobile`).

## §8 Test plan summary

Per lane: `cd apps/mobile && npm ci && npm test` (jest-expo), `npm run typecheck`,
`APP_PROFILE=development npm run bundle` and (for `build-profiles`) `APP_PROFILE=test-g1 npm run bundle`;
the repo-root script job (`node --test scripts/native/__tests__/`) and NATIVE-CI green; Lane scope green.
Each lane adds `docs/validation/<VTID>/{scope.json,staging-tests.json,plan-sparring.md}` (read-only
shell-navigation specs only). `real-g1-switch` has no CI build to run until the owner provides G1; its
verification is the §5 smoke re-run against real G1, recorded in `docs/validation/g1/`.
