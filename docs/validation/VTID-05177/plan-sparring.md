# VTID-05177 — plan sparring record (Native app Wave 1, N4: remote config, native push routing, deep and universal links)

| | |
|---|---|
| VTID | **VTID-05177** — package N4-GW (vitana-platform: `GET /api/v1/app-config`, native push routing behind a dark switch, native token `device_type`) |
| Sibling VTID (same sparred plan) | N4-APP (vitana-v1: remote config client, provider-neutral push client, link routing) |
| Program | VTID-05021 (native app) Wave 1, item "push + deep links + universal links; app-config endpoint" |
| Sparring session | `6cdec1cb-27a8-47b5-84ae-78ab520d6c81` |
| Partner | `plan-sparring-partner` agent (independent, read-only) |
| Change class | standard |
| Rounds | 2 |
| Verdict | **CONVERGED** |
| Plan hash, round 1 | `56da4ad4a72c9cc078da164b84c620102852dcce2772039a911ec0c21dd6fcfd` |
| Plan hash, final | `7fd036cecf7559f7a291085b2a861ea19311420524b01df10014526667ad523f` |

Plan hash = sha256 of the UTF-8 text strictly between the `plan:begin` and `plan:end` HTML-comment markers in the
"Final plan" section below.

Owner approval: Gate 1 2026-10-13: owner delegated decisions ("Continue and make the decisions yourself"; "build in parallel … quickest possible"); planner defaults taken

Planner defaults taken at Gate 1 (open questions of the plan, listed after the plan block): provider-neutral, dark
parts ship before G2 and everything that loads Firebase or turns routing on waits for G2 (Q1); the duplicate guard is
built and shipped off behind its own switch (Q2); flags are turned on only by a reviewed `defaults.ts` change, with
`system_controls` used for kills only (Q3); no link association until G1 provides a web host (Q4); the in-memory
`KeyValueStore` until N1's adapter lands (Q5); the server badge on the `notifyUser` path only (Q6).

## Rounds

| Round | Finding | Severity | Answer | Where in the final plan |
|---|---|---|---|---|
| R1 | F1 — the same-phone duplicate guard can silence a working Appilix device ("no `Appilix %` row" is not "no Appilix device") | major | ACCEPTED — the guard ships disabled behind its own switch `NATIVE_PUSH_APPILIX_GUARD_ENABLED`; turning it on is its own Gate 2 with read-only evidence | Change 6; Facts F8; Interfaces; Rollout 5–6; Open question 2 |
| R1 | F2 — badge count per push on the cron paths | major | ACCEPTED — the unread count is read once per recipient with an `ios_native` token, `notifyUser` only; cron paths send no badge | Change 7; Tests; Out of scope; Open question 6 |
| R1 | F3 — editing production `public/.well-known/*` makes N4-APP a web deploy and risks the live Appilix app | major | ACCEPTED (safest variant) — production `.well-known` untouched; dev/test builds associate with the G1 host only | Meta; Changes 13–14; Tests; Rollout 3; Out of scope |
| R1 | F4 — F8 misattributed which web client sends `device_type` | minor | ACCEPTED — F8 reworded | Facts F8 |
| R1 | F5 — notifications mount line | minor | ACCEPTED with a correction — F11 quotes the full mount statement (`index.ts:1342`) | Facts F11 |
| R1 | F6 — `upsertDeviceToken` row type must change | minor | ACCEPTED — Change 4 names the row-type change; today's clients keep today's keys | Change 4 |
| R1 | F7 — no global rate limiter for a public route | minor | ACCEPTED — per-IP `express-rate-limit` 120/min with a 429 test | Facts F11a; Change 3; Tests |
| R1 | F8 — goldens must be recorded before the refactor | minor | ACCEPTED — the switch-off golden fixtures land in a separate first commit, green on unmodified code, never regenerated in the same PR | Tests ("Golden fixtures first") |
| R2 | F9 — the guard switch alone could suppress Appilix while routing is off | minor | ACCEPTED — `hasOnlyNativeAppDevices` short-circuits to `false` unless `NATIVE_PUSH_DIRECT_ENABLED` is on; test added | Change 6 |
| R2 | — | — | CONVERGED; every R1 and R2 finding closed | — |

The partner's verbatim output for both rounds is kept in the sparring session
`6cdec1cb-27a8-47b5-84ae-78ab520d6c81`; this table records each finding's answer as the planner gave it. The planner's
responses are reproduced verbatim after the plan block.

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard. One sparred plan, two VTIDs:
  - **N4-GW** (vitana-platform): Changes 1–7.
  - **N4-APP** (vitana-v1): Changes 8–14.
  - A third, later VTID **N4-FCM** (vitana-v1) adds the React Native Firebase provider and the native badge setter. It starts only after G2 passes and gets its own short sparred delta plan (Rollout 4). This plan fixes its interface now so that it is a drop-in.
- **Program:** VTID-05021 (native app), Wave 1 item "push + deep links + universal links; app-config endpoint".
- **Repos / areas:**
  - vitana-platform:
    - `services/gateway/src/routes/app-config.ts` (new), `services/gateway/src/services/app-config/` (new: defaults, reader, repository);
    - `services/gateway/src/index.ts` (one mount);
    - `services/gateway/src/orb/developer/domain-atlas.ts` (claim the new route file);
    - `services/gateway/src/routes/notifications.ts`, `routes/notifications-repository.ts`;
    - `services/gateway/src/services/notification-service.ts`, `services/notification-service-repository.ts`;
    - `services/gateway/src/routes/scheduled-notifications.ts`, `services/reminders-dispatch.ts`;
    - tests, `docs/validation/<N4-GW>/`.
  - vitana-v1:
    - `apps/mobile/src/{config,push,linking}/**` (new), `apps/mobile/app/_layout.tsx`, `apps/mobile/app.config.ts`, `apps/mobile/package.json` (no new native dependency, see Change 8);
    - tests, `docs/validation/<N4-APP>/`.
    - **Not touched:** `public/.well-known/*`, `nginx.conf`, `src/**`. N4-APP is therefore not a web deploy (round 1, F3).
- **Database:** no migration planned. Before code, a read-only check confirms that `user_device_tokens.device_type` and `app_version` exist on the live Supabase project and on the Aurora schema (F9). A missing column becomes one idempotent `ADD COLUMN IF NOT EXISTS` migration and is listed in Gate 2.
- **Regulatory impact:** none. App-config carries no member data. Push payloads and their recipients are unchanged.

## Facts (file:line, origin/main)
**Push today (vitana-platform)**
- F1 Firebase Admin is initialised once with `projectId: 'lovable-vitana-vers1'` and application-default credentials (`services/gateway/src/services/notification-service.ts:29-34`). That GCP project's billing is off (program decision 6). G2 is **not passed**.
- F2 `sendPushNotification` (`notification-service.ts:318-362`) sends `fcm.send({ token, notification, data, android.tag / apns-collapse-id, webpush.fcmOptions.link = data.url })`. It sets no `aps.badge`. It returns `sent | stale | error`.
- F3 `sendPushToUser` (`:366-418`):
  - It reads live tokens through `fetchLiveDeviceTokensForUser`. That function selects only `fcm_token, device_label` (`notification-service-repository.ts:28-35`).
  - `excludeAppilixTagged` drops labels starting with `Appilix ` (`:389-391`).
  - Stale tokens are revoked (`:405-412`).
- F4 There are **three** dispatch sites with Appilix-first routing, and each is a little different:
  - (a) `notifyUser` (`notification-service.ts:850-903`):
    - with `data.url`: Appilix first. Only if Appilix reports no device does FCM run, and then with `excludeAppilixTagged: true` (`:879-896`);
    - without `data.url`: FCM first, then Appilix if zero FCM sends (`:897-902`);
    - suppression uses `isSignedOutOnAllKnownDevices || hasLostDeviceToAnotherAccount` (`:875-877`).
  - (b) `routes/scheduled-notifications.ts:1381-1399`: the same split on `hasDeepLink` (`:1357`). Suppression uses only `isSignedOutOnAllKnownDevices` (`:1383`), and the deep-link FCM fallback does **not** exclude Appilix-tagged tokens (`:1388-1390`). This is an existing asymmetry and is not changed here (Out of scope).
  - (c) `services/reminders-dispatch.ts:316-340`: FCM first, then Appilix when the user has no `Appilix %` token (`countAppilixNativeDeviceTokens`, `routes/scheduled-notifications-repository.ts:349-357`) or when FCM sent nothing.
- F5 `hasLostDeviceToAnotherAccount` (`notification-service.ts:474-500`) treats a label matching `/appilix|\bApp\d+\b/i` as an "Appilix-reachable native device" (`:489`). A native-app token label must never match it, or it would feed Appilix suppression wrongly.
- F6 Appilix pushes address `user_identity`, not a device. The link travels as `open_link_url` = `APPILIX_APP_URL || https://vitanaland.com` + `data.url` (`:539-566`). Appilix's identity→device registry keeps stale mappings that the gateway cannot purge (`:423-433`).
- F7 `POST /api/v1/notifications/token` (`routes/notifications.ts:37-108`):
  - it reads only `fcm_token, device_label` (`:41`);
  - device takeover (`:62`), upsert on `(user_id, fcm_token)` (`:72-78`, `notifications-repository.ts:29-42`), and a 30-day prune of the user's own stale rows (`:100-105`).
  - `DELETE /token` soft-revokes on sign-out (`:112-131`).
  - No test covers the route (`notifications-repository.ts:1-3`).
- F8 Only `registerAppilixDevice` (`vitana-v1 src/lib/pushNotifications.ts:273-306`) sends `device_type: 'appilix'` and `package_name` (`:279-283`), with the label `Appilix <UA>` (`:282`).
  - It sends `fcm_token` only when the WebView bridge returned one (`:284-286`). Without one, the gateway answers 400 `fcm_token is required` (`routes/notifications.ts:42-44`) and stores no row. So an Appilix member can be reachable through Appilix's `user_identity` and still have **no** `Appilix %` row.
  - The web path `registerTokenWithBackend` (`:247-266`) sends only `fcm_token` and `device_label` = browser UA (`:254-257`), with neither `device_type` nor `package_name`.
  - The gateway ignores `device_type` and `package_name` (F7).
- F9 `user_device_tokens` was created without `device_type` (`supabase/migrations/20260225000000_notification_system.sql:6-15`). `device_type`, `os_version` and `app_version` were added later (`20260427180000_vtid_02003_phase_5a_tier2_schema.sql:400-410`), inside an `IF to_regclass(...)` guard, so whether they exist live must be checked. The Aurora restore scripts list the table's defaults and indexes (`services/postgrest-aurora-proxy/aurora-restore-01-defaults.sql:2245-2247`, `-03-indexes.sql:1164-1165`) but not its columns. Aurora presence is unverified.
- F10 `GET /api/v1/notifications/unread-count` already exists (`routes/notifications.ts:154-166`). It is the badge source.
- F11 The notification route is mounted at `index.ts:1342` (`mountRouterSync(app, '/api/v1/notifications', notificationsRouter, { owner: 'notifications' })` at `1e508fb3c`; `:1345` is the realtime-relay mount). Auth-free GETs exist, for example `/api/v1/admin/build-info` (`index.ts:1359-1361`).
- F11a The gateway has no global rate limiter. Public routes add `express-rate-limit` per route (`package.json:60`; for example `routes/me-phone.ts:16,31` and `routes/creators.ts:13,33-…`).
- F12 Today's tests that pin push behaviour:
  - `test/services/notification-device-ownership.test.ts`;
  - `test/vtid-04320-reminders-dispatch.test.ts`;
  - `test/scheduled-notifications-{night-push,whats-new,daily-feature-tip}.test.ts`;
  - `test/vtid-04674-notification-controls-wiring.test.ts`;
  - 30 test files in total import `notification-service`.

**Remote config (vitana-platform)**
- F13 No member-facing app-config or feature-flag endpoint exists (`git grep -i "app-config\|min_supported_version" origin/main -- services/gateway/src`: no hits).
- F14 `system_controls` (`services/system-controls-service.ts`):
  - It has a 10 s cache (`:29`) and a 3 s fetch timeout (`:37`).
  - Rows are `{key, enabled, scope, reason, expires_at, …}` (`:52-61`) and are disarmed by default. Every change needs a reason, is audited, and emits an OASIS event (`:1-16`, `:245-248`).
  - `getSystemControl` returns `null` both on a missing row and on an error (`:128-180`), so the two cases cannot be told apart.
  - The table lives in the shared Supabase project, so staging and production gateways read the **same** rows.
- F15 Domain atlas: every `src/routes/**.ts` file must be claimed by a domain. The drift guard is in `test/vtid-04560-role-separation-regression.test.ts` (`orb/developer/domain-atlas.ts:1-12`). The `infra` domain is at `:203-213`.
- F16 Route mounting goes through `mountRouterSync(app, path, router, { owner })` (`governance/route-guard.ts:248-…`), which detects duplicate routes.
- F17 STAGING-VERIFY (`scripts/ci/staging-verify/lib.cjs`):
  - `http` tests have `target` `gateway|frontend` (`:132`), `expect_status`, `expect_content_type`, `expect_json` and `expect_body_contains` (`:340-366`);
  - an `/api` path defaults to expecting JSON (`:351`).

**App and web (vitana-v1)**
- F18 `apps/mobile` (Wave 0, VTID-05157):
  - Only the `development` and `test-g1` profiles exist; `production` throws (`apps/mobile/app.config.ts:16-35`).
  - Identifiers are `com.exafy.maxina.dev` / `com.vitanaland.app.dev` (`:19-22`).
  - `scheme: 'maxina'` is marked "placeholder; universal links come in Wave 1" (`:43-44`).
  - No `googleServicesFile` (`:12`).
  - `src/config/env.ts` has no default URL and refuses production and staging hosts (`:19-55`).
  - Dependencies are Expo SDK 57 with exact pins; `expo-linking` and `expo-constants` are present; there is no storage, notifications or Firebase package (`package.json:18-33`).
  - The README defers push, RNFB and `google-services` to G2 (`apps/mobile/README.md:63`).
- F19 `public/.well-known/apple-app-site-association:1-11` has one entry, `62Q26QSEJW.com.exafy.maxina`, with `"paths": ["*"]`. Today's Appilix store app therefore claims every vitanaland.com path. `public/.well-known/assetlinks.json:1-11` holds `com.vitanaland.app` with two fingerprints.
- F20 `nginx.conf:19-22` serves the AASA file as `application/json`. `assetlinks.json` is served by extension. Both files are inside the stage deploy's `public/**` path trigger (`.github/workflows/AWS-STAGE-DEPLOY-FRONTEND.yml:33-41`).
- F21 Link targets in `src/App.tsx`:
  - `/auth/confirmed` (`:824`), `/oauth/complete` (`:828`), `/reset-password` (`:843`) and `/i/:code` (`:876`);
  - mobile OAuth returns to `${PUBLIC_BASE_URL}/oauth/complete?return=mobile&provider=…&next=…` (`src/hooks/useSupabaseOAuthSignIn.ts:41`).
- F22 The program plan says G2 must pass "before any native push work starts" (`docs/programs/native-app/NATIVE-APP-PLAN.md:92`). This plan proposes a narrower reading that the owner has to confirm (Open question 1):
  - provider-neutral work ships dark before G2;
  - anything that loads Firebase into the app, or turns native routing on, waits for G2.

## Changes (numbered)
**N4-GW (vitana-platform)**

1. **App-config defaults:** a new file, `services/gateway/src/services/app-config/defaults.ts`. It holds the checked-in source of truth:
   - `APP_CONFIG_SCHEMA_VERSION = 1`;
   - per platform (`ios`, `android`):
     - `min_supported_version: '0.0.0'`, `recommended_version: null`, `update_url: null`;
     - `flags`: `push_enabled`, `health_sync_enabled`, `orb_native_enabled`, all `false`.

   Turning a flag **on**, or raising a minimum version, is a reviewed code change that goes through Gate 2. N5 and N6 each add their own flag line in their own VTIDs.
2. **Kill switches:** `services/app-config/app-config-repository.ts` reads `system_controls` rows whose key starts with `native_app.kill.`. Examples: `native_app.kill.ios.push_enabled`, `native_app.kill.all.orb_native_enabled`.
   - The read uses the existing service-role REST pattern with a 3 s timeout. Unlike `getSystemControl`, it returns `{rows} | {error}`, so an error and an empty result stay separate (F14).
   - An armed, unexpired kill row forces its flag to `false`.
   - A control can only switch a flag **off**. It can never turn a flag on or change a version.
   - Because staging and production share these rows (F14), a kill switch applies to both. That is intended, since a kill only ever disables.
   - Arming uses the existing governance controls API and audit. No new admin UI.
3. **Route:** `routes/app-config.ts` serves `GET /` with no auth, no tenant and no member data. It merges the defaults with the kills and answers:
   - `200 { ok: true, schema_version, generated_at, ttl_seconds: 300, platforms: { ios: {...}, android: {...} } }`, with `Cache-Control: public, max-age=60`;
   - if the kill read errors: `503 { ok: false, error: 'config_unavailable' }`, so the app keeps its cached config. The endpoint never answers with flags it could not check.

   Mounting and atlas:
   - Rate limit: a per-IP `express-rate-limit` (120 requests/min, `standardHeaders`), following the existing per-route pattern (F11a).
     - The payload is static.
     - `Cache-Control: public, max-age=60` lets the edge absorb repeats.
     - The kill read sits behind its own 10 s in-process cache, the same TTL as `system_controls` (F14).
     - So the limiter only bounds abuse; it is not needed for load.
   - Mounted at `index.ts` next to the other auth-free GETs: `mountRouterSync(app, '/api/v1/app-config', appConfigRouter, { owner: 'app-config' })`.
   - The `infra` domain in `domain-atlas.ts` claims `/^app-config$/`, adds `system_controls` to `tables`, and lists `native_app.kill.*` and `NATIVE_PUSH_DIRECT_ENABLED` under `flags`.
4. **Token route:** `POST /notifications/token` accepts optional `device_type` and `app_version`.
   - Allowlist: only `ios_native` and `android_native` are stored. Any other value, including today's `'appilix'`, is stored as `null`, exactly as now. Rows from today's clients are therefore byte-identical.
   - For a native type, the gateway sets `device_label` itself to `native-ios <app_version>` or `native-android <app_version>`. The client's label is ignored, so it can never match the Appilix detectors in F3 and F5.
   - `app_version` is capped at 32 characters and must match `^[0-9A-Za-z.+-]+$`.
   - Takeover and prune are unchanged.
   - Row-shape change: the `row` parameter type of `upsertDeviceToken` (`routes/notifications-repository.ts:29-41`) gains `device_type?: 'ios_native'|'android_native'|null` and `app_version?: string|null`.
     - Both keys are written **only when** the type is native.
     - For today's clients the object passed to `.upsert()` keeps exactly today's keys (`user_id, tenant_id, fcm_token, device_label, updated_at, revoked_at, revoked_reason`). Re-registering never overwrites an existing value with `null`.
   - When a token is registered with a native type while the switch from Change 5 is off, the gateway logs `[Notifications] native token registered while NATIVE_PUSH_DIRECT_ENABLED is off`. Rollout 5 must never be crossed silently.
5. **Native routing switch:** `NATIVE_PUSH_DIRECT_ENABLED` (env, default unset = off). **Off: no behaviour change at any of the three sites in F4.** On:
   - `fetchLiveDeviceTokensForUser` also selects `device_type`. `sendPushToUser` gains `tokenClass?: 'native' | 'legacy'`, where `native` = `device_type in (ios_native, android_native)` and `legacy` = everything else.
   - At each of the three sites, a native pass runs first: `sendPushToUser(..., { tokenClass: 'native' })` goes straight to FCM whether or not there is a `data.url`, and its sends count in the same `fcmTally`.
   - Then today's logic runs **unchanged, over legacy tokens only**. Appilix-first for URL pushes, the `excludeAppilixTagged` filter, both suppressions and every fallback stay as they are for Appilix and web tokens.
   - "FCM delivered zero" fallbacks count legacy sends only. A native send must not hide a missing Appilix delivery to another device during the transition.
   - The routing lives in one helper, `dispatchPush(...)` in `notification-service.ts`, which the three sites call. Each site passes its own existing legacy behaviour as parameters (suppression predicate, deep-link FCM exclusion), so the asymmetry in F4b is kept, not "fixed".
6. **Same-phone duplicate guard: built but shipped disabled behind its own switch, `NATIVE_PUSH_APPILIX_GUARD_ENABLED`** (env, default unset = off). It is separate from `NATIVE_PUSH_DIRECT_ENABLED`.
   - The problem: a member who updates the store app from Appilix to native keeps the same bundle. Appilix's stale identity mapping (F6) can still reach that phone and show a second copy of every push.
   - The guard's rule: when a user has at least one live native token and **no** live `Appilix %` token, Appilix is suppressed. It is the predicate `hasOnlyNativeAppDevices`, OR'd into each site's existing `appilixSuppressed`. The predicate short-circuits to `false` unless `NATIVE_PUSH_DIRECT_ENABLED` is also on (one guard line at its top), so turning on the guard switch alone can never suppress a working Appilix delivery (sparring R2-F9); test: guard on + routing off + native token present → Appilix not suppressed.
   - **Why it ships off:** "no `Appilix %` row" does not mean "no Appilix device". The WebView bridge often captures no FCM token, and then no row is stored at all (F8). With the guard on, such a member's other Appilix phone would silently lose every push. A duplicate is the lesser harm than a lost push, so until the guard is turned on, duplicates on an updated phone are accepted.
   - **Turning it on** is its own Gate 2, with read-only evidence: how many members have an Appilix identity (Appilix-tagged `user_device_tokens` rows of any state, plus `push_outcome = delivered_appilix` history) but no live `Appilix %` token row.
7. **Badge (only when `NATIVE_PUSH_DIRECT_ENABLED` is on, iOS native only, `notifyUser` path only):**
   - In `notifyUser`, the native pass reads `countUnreadNotifications` (F10) **only when** the recipient's live tokens include an `ios_native` row. That is one count per such recipient, never one per token, and none for web-only or Appilix-only recipients.
   - The result goes into `apns.payload.aps.badge` on the `ios_native` sends. If the count read fails, the badge is left out.
   - The two cron paths (`scheduled-notifications.ts`, `reminders-dispatch.ts`) send **no** badge. This is the smaller change, chosen over a batched grouped count per tick. The app refreshes the badge itself from `unread-count` on foreground (Change 10).
   - `android_native` gets no badge field, because launchers show their own dot.

**N4-APP (vitana-v1)**

8. **No native dependency.** N4-APP adds only JavaScript modules and app config. `@react-native-firebase/*`, `expo-notifications` and any `google-services` / `GoogleService-Info.plist` wait for N4-FCM after G2 (F18, F22).
   - The key-value cache uses the storage adapter N1 provides in `packages/core` (MMKV per the program library mapping).
   - Until that adapter lands, N4 depends on a `KeyValueStore` interface with an in-memory implementation (Open question 5).
9. **Remote config client:** `apps/mobile/src/config/remote-config.ts`.
   - `fetchAppConfig()` calls `GET ${requireUrl(config,'gatewayUrl')}/api/v1/app-config`, so it is G1-only by construction (F18), with a 3 s timeout. It runs on launch and on return to the foreground, at most once per `ttl_seconds`.
   - The last good response is validated against a zod schema (unknown flags ignored, missing flags = `false`) and cached with `fetched_at`.
   - Fail-safe:
     - no gateway URL, a network error or a 503 means the cached config is used if it is younger than 7 days; otherwise built-in defaults (every flag `false`, `min_supported_version '0.0.0'`);
     - a failure never blocks the member.
   - `useAppConfig()` returns `{ flags, updateRequired, updateRecommended, updateUrl, source: 'remote'|'cache'|'default' }`.
   - Versions compare numerically per dotted part. The app's version comes from `expo-constants`.
   - N3's shell renders the update-required screen and its strings (Interfaces).
10. **Push client (provider-neutral):** `apps/mobile/src/push/`.
    - `PushProvider` interface: `isAvailable`, `getToken`, `onTokenRefresh`, `requestPermission`, `getInitialOpen`, `onOpen`, `onForegroundMessage`, `setBadge`.
    - `NoopPushProvider` is the only implementation in N4-APP.
    - `registerPushToken(session)` posts `{ fcm_token, device_type: 'ios_native'|'android_native', app_version }` to `/api/v1/notifications/token`. It runs after sign-in and on token refresh, only when `provider.isAvailable` **and** `flags.push_enabled`.
    - `unregisterPushToken()` sends `DELETE /token` before N3 clears the session.
    - No permission prompt at launch. Screen lanes call `requestPermission()` from the same UI points the web uses (`TurnOnNotificationsCard`, `EnableRemindersPrompt`).
    - Badge: on foreground, `GET /notifications/unread-count` then `provider.setBadge(count)`. With the Noop provider this does nothing.
11. **Tap routing:** `apps/mobile/src/linking/resolve-link.ts`.
    - `resolveLink(input)` takes a relative path, an `https://` URL on an allowed link host (`vitanaland.com`, `www.vitanaland.com`, plus the profile's link hosts) or a `maxina://` URL. It returns `{ pathname, params } | null`. Anything else gives `null`, which opens home; foreign hosts are never opened inside the app.
    - Push opens read `data.url`, falling back to `open_link_url`. That fallback covers an Appilix push that reaches an updated phone during the transition (F6).
    - `useLinkRouting()` in `_layout.tsx` feeds push opens and incoming links through `resolveLink` into `router.push`. Before sign-in, the target is held and replayed after N3's auth guard.
12. **Auth and invite links:** the resolver tags four link kinds for N3:
    - `/auth/confirmed` and `/reset-password` → `{ kind: 'auth', tokens }`, parsed from the hash or the `?code=`. N3's auth module consumes them through `onAuthLink`.
    - `/oauth/complete` → `{ kind: 'oauth_return', … }`. This is only a fallback, because N3 uses native `signInWithIdToken`.
    - `/i/:code` → `{ kind: 'invite', code }`.

    The Supabase redirect URLs are the web's own, unchanged (F21). No Supabase project configuration changes.
13. **Associated domains (dev/test builds only, G1 host only):**
    - `app.config.ts` reads `APP_LINK_HOSTS` per profile. It is unset (no association) for `development`, and set for `test-g1` only to the G1 test web host once G1 provides one.
    - A build-time check rejects `vitanaland.com`, `www.vitanaland.com` and every `preview-aws*` host, reusing `isBlockedHost` from `env.ts`.
    - iOS: `associatedDomains: applinks:<G1 host>`. Android: `intentFilters` with `autoVerify` for the four path patterns.
    - That G1 host serves its own AASA and `assetlinks.json` for `.dev` identifiers. That file belongs to the G1 environment, not to this repo's `public/`.
    - `scheme` stays `maxina` and becomes the custom-scheme route for `simctl openurl` / `adb` tests.
14. **Production `.well-known` is not touched (round 1, F3).**
    - `public/.well-known/apple-app-site-association` and `assetlinks.json` stay byte-identical. Today's Appilix app keeps `"*"`, and testers who have both apps see no link ambiguity.
    - Universal links on vitanaland.com for the native store app (narrowing `"*"`, the store identifiers, the store fingerprints) are a Wave 3 store-release item. N4-APP is therefore not a web deploy.
    - No user-visible strings, no `App.tsx` route and no `screens.json` change, so there is no What's New entry and no registry entry.

## Interfaces
- `GET /api/v1/app-config`:
  - no auth;
  - `200 { ok, schema_version: 1, generated_at, ttl_seconds, platforms: { ios|android: { min_supported_version, recommended_version|null, update_url|null, flags: Record<string, boolean> } } }`;
  - or `503 { ok:false, error:'config_unavailable' }`.
  - Adding a flag is additive. Removing or renaming one bumps `schema_version`.
- `POST /api/v1/notifications/token`: body `{ fcm_token, device_label?, device_type?: 'ios_native'|'android_native', app_version? }`. The response is unchanged.
- Env `NATIVE_PUSH_DIRECT_ENABLED`: `true` turns on Changes 5 and 7. Anything else is off.
- Env `NATIVE_PUSH_APPILIX_GUARD_ENABLED`: `true` turns on Change 6. It only has an effect when `NATIVE_PUSH_DIRECT_ENABLED` is also on. Anything else is off.
- `system_controls` keys `native_app.kill.<ios|android|all>.<flag>`: `enabled=true` forces the flag off.
- Inside the app, for N3, N5 and N6:
  - `useAppConfig()`;
  - `PushProvider`, `registerPushToken`, `unregisterPushToken`;
  - `resolveLink`, `onAuthLink(handler)`, `onInviteLink(handler)`;
  - `KeyValueStore` (from N1 when available).
  - N3 owns the update-required screen and its i18n keys (DE first), the post-sign-in hook that calls `registerPushToken`, and the sign-out hook that calls `unregisterPushToken`.
- N4-FCM (after G2) implements `PushProvider` with `@react-native-firebase/messaging` (decision 6: one FCM token type on both platforms, so the gateway sender is unchanged; APNs goes through FCM). Badge uses a minimal setter chosen in that delta plan.

  Why RNFB rather than `expo-notifications` raw tokens: the raw iOS token is an APNs token, which would need a new APNs sender in the gateway. Expo's push relay would add a third party that holds member notification content.

  If G2 ends with a new Firebase project, only N4-FCM's config files and the gateway credential change. If the owner leaves Firebase altogether, a new `device_type` (for example `ios_apns`) and a new provider slot in without touching N4-APP's callers.

## Tests
**vitana-platform (Jest, N4-GW)**
- `test/vtid-<N4-GW>-app-config.test.ts`:
  - 200 shape, no auth header needed, `Cache-Control`;
  - every default flag is `false`, and the minimum version is `'0.0.0'`;
  - an armed kill forces its flag off; an expired kill is ignored; a kill can never turn a flag on or change a version;
  - `all` applies to both platforms; an unknown kill key is ignored;
  - a repository error gives 503 with no `platforms`;
  - the response contains none of `user_id`, `email`, `tenant_id` (deep key scan).
- Mount test: `GET /api/v1/app-config` is registered once (route guard). `npm run test:roles` stays green (atlas drift guard, F15).
- `test/routes/notifications-token.vtid-<N4-GW>.test.ts`, the first coverage for the route:
  - today's web and Appilix bodies (F8) produce the identical upsert row with `device_type` null;
  - `ios_native` / `android_native` store their type, and the server-set label does not match `/^Appilix /` or `/appilix|\bApp\d+\b/i`;
  - a bad `app_version` is dropped;
  - takeover and prune calls are unchanged.
- **Golden fixtures first:** the PR's **first commit** adds the switch-off golden fixtures and their test, recorded from today's unmodified dispatch code for all three sites. CI must be green on that commit. The `dispatchPush` refactor comes in later commits, and the goldens are never regenerated in the same PR.
- `test/services/native-push-routing.vtid-<N4-GW>.test.ts`, table-driven over the three sites in F4 and over token mixes (web, Appilix, native iOS, native Android, combinations), with URL and without:
  - **Switch off:** the recorded call sequence (Appilix calls, FCM tokens sent, outcome) equals today's, captured from the current code before the change (golden fixtures).
  - **Switch on:**
    - native tokens are always sent via FCM;
    - legacy behaviour over legacy tokens equals the switch-off golden;
    - the zero-send fallbacks count legacy sends only;
    - stale native tokens are revoked;
    - `aps.badge` is set for `ios_native` only, and is absent if the count fails;
    - the unread count is read once per recipient that has an `ios_native` token, and never for other recipients;
    - the two cron paths send no badge;
    - the duplicate guard (Change 6) is inactive while `NATIVE_PUSH_APPILIX_GUARD_ENABLED` is off, even with direct routing on;
    - with the guard on, it suppresses Appilix only when there are native tokens and no `Appilix %` token.
  - Rate limit: request 121 from one IP within a minute gets 429 JSON.
- Existing suites stay green unchanged:
  - `notification-device-ownership`, `vtid-04320-reminders-dispatch`, the three `scheduled-notifications-*` tests, `vtid-04674-notification-controls-wiring`;
  - the other 30 files importing `notification-service`;
  - `npm run test:support`, `npm run test:operator`, `npm run test:roles`;
  - `tsc`, lint.
- No test writes to the shared database. Supabase and FCM are mocked.

**vitana-v1 (N4-APP)**
- `apps/mobile` Jest:
  - `remote-config.test.ts`: fresh fetch; schema validation (unknown flag ignored, missing = false); 503, network error and no-URL fall back to cache, then to defaults after 7 days; `updateRequired` and `updateRecommended` comparisons (`1.10.0 > 1.9.9`); TTL throttling; the fetch URL is built only through `requireUrl`, and a production or staging URL throws.
  - `resolve-link.test.ts`: relative, allowed host, `maxina://`, foreign host → null, `open_link_url` fallback, auth hash and `?code`, `/i/:code`, `/oauth/complete`, held link replayed after sign-in.
  - `push-registration.test.ts`: Noop provider makes no call; with a fake provider, registration runs only when `isAvailable && flags.push_enabled`, with the body from Change 10; sign-out calls DELETE before the session clears; badge sync calls `setBadge`.
  - `app-config.test.ts` (extended): `APP_LINK_HOSTS` maps to `associatedDomains` and `intentFilters`; unset gives none; a production or staging host throws; no Firebase plugin and no `googleServicesFile` in any profile.
  - `npm run typecheck`, `npm test`, bundle, `deps:check`.
- `apps/mobile/tests/well-known-unchanged.test.ts`: asserts that `../../public/.well-known/*` are byte-identical to the committed originals, by sha256. That pins F3 against an accidental edit.
  - It lives in `apps/mobile`, not `src/`, because a `src/**` file would trigger the web stage deploy (F20).
  - Plus the root `npm run lint` for the `apps/mobile` lint scope.

**Staging verification (read-only; `docs/validation/<VTID>/staging-tests.json` per VTID; no POST, PUT or DELETE probes, not even rejected probes)**
- **N4-GW (gateway):**
  - `http` `GET /api/v1/app-config`: expect 200, JSON, `expect_json { ok: true }`, `expect_body_contains` `"push_enabled":false`, `"min_supported_version":"0.0.0"`.
  - `http` `GET /api/v1/admin/build-info` reports the verified commit.
  - `existing`: the Jest files above, with this reason: token registration and push dispatch are writes or sends to the shared production database and to real devices, so they are proven only by mocked Jest. The routing switch is off on staging.
- **N4-APP:** no web deploy. `apps/**` is outside the stage deploy's path trigger (F20), so STAGING-VERIFY has nothing new to verify there.
  - `docs/validation/<N4-APP>/staging-tests.json` holds one `existing` entry (the `apps/mobile` Jest run plus the `.well-known` guard), with this reason: the native app is not deployed to staging, native builds point at G1 only, and the production `.well-known` files are unchanged.
  - The live behaviour N4-APP depends on is the read-only `GET /api/v1/app-config` check in N4-GW.

## Rollout / gates
1. Spar this plan, then Gate 1. Allocate N4-GW and N4-APP, each citing the sparring record. Before code, run the read-only column check (F9); any missing column adds a migration to N4-GW.
2. **N4-GW:**
   - The PR goes through CI, merge, staging deploy, STAGING-VERIFY and Gate 2. Gate 2 lists every commit between production and the verified commit, plus any migration.
   - Then the production gateway deploy, pinned to the verified commit (`AWS-PROD-DEPLOY-GATEWAY.yml`, `expected_commit`).
   - `NATIVE_PUSH_DIRECT_ENABLED` stays unset in every task definition. N4-GW makes no task-definition change.
3. **N4-APP:**
   - It depends on N4-GW only for live G1 use; its tests mock the gateway.
   - It deploys nothing (no web files change), so it has no Gate 2. It is done when merged with green checks.
   - It can merge before N3. The hooks stay unused until N3 calls them.
4. **G2 (owner gate, not passed):**
   - N4-FCM starts only when G2 records proven FCM delivery and confirmed Exafy ownership (or the new Firebase project).
   - It then adds RNFB, the config files as build secrets for `test-g1` only, the badge setter and device tests on G1. Native tokens are registered against the **G1** gateway only.
5. **Turning it on:**
   - Before any store build with push reaches members (Wave 3), set `NATIVE_PUSH_DIRECT_ENABLED=true` in production through a reviewed task-definition change (own VTID, read the live task definition first). Then set `push_enabled: true` for the shipped platform in `defaults.ts` (Gate 2).
   - `NATIVE_PUSH_APPILIX_GUARD_ENABLED` stays off through that step. Turning it on is a separate Gate 2 with the read-only evidence from Change 6.
   - Order matters: switch first, then flag, then store build. A native token on production with the switch off would be treated as a web token. For URL pushes it would sit behind Appilix-first, and the push could be lost (the token-route warning from Change 4 flags this).
6. **Rollback:**
   - Unset either env switch: routing returns exactly to today's (or to direct routing without the guard).
   - Arm a `native_app.kill.*` control: the feature is off on the next fetch.
   - Redeploy the previous commit to revert the code.

## Out of scope
- **Appilix:** removing Appilix sending and the bridge (program Wave 3, after the adoption threshold).
- **Existing dispatch-site differences:** the existing asymmetry in F4b (scheduled-notifications' deep-link FCM fallback does not exclude Appilix tokens and uses the narrower suppression). It is kept byte-for-byte and gets its own ticket.
- **Universal-link scope:** any change to the production `public/.well-known/*` files, narrowing the store AASA entry's `"*"`, and store identifiers in `app.config.ts`. All belong to G3 / the Wave 3 store release.
- **Badges on the cron paths:** server-set badges for `scheduled-notifications` and `reminders-dispatch` (app-side refresh instead).
- **Push features:** notification categories and chat reply actions (later), and a foreground in-app banner (lane decision, parity with web).
- **Other app-config questions:** per-tenant flags, and enabling features via `system_controls` (kills only).
- **G2 itself:** proving the Firebase project, and any gateway Firebase credential change. G2 has its own VTID.
- **Owned elsewhere:** sign-in flows, session handling and the update-required screen (N3); Health Sync and ORB flags beyond their names (N5, N6).

<!-- plan:end -->

### Open questions (planner default in bold)
1. **G2 scope (F22):** the program plan says no native push work before G2. Should the provider-neutral, dark parts (token `device_type`, routing behind an off switch, app push interface with the Noop provider, link routing) ship now, with everything that loads Firebase or turns routing on waiting for G2? **Default: yes, split as in Rollout 3–5.** The alternative is to hold Changes 4–7 and 10 until G2.
2. **Duplicate guard (Change 6):** **Default: built, shipped off behind `NATIVE_PUSH_APPILIX_GUARD_ENABLED`. Duplicates on an updated phone are accepted until a separate Gate 2 shows, from read-only evidence, how many members are Appilix-reachable without an `Appilix %` row.**
3. **Where flags are turned on:** only by a reviewed change to `defaults.ts` (Gate 2), with `system_controls` used only for kills. **Default: yes.** The alternative is runtime enable through controls. It is faster, but it is shared by staging and production and is not reviewed.
4. **G1 link host:** **Default: no association until G1 provides a web host. That host serves its own `.well-known` files for the `.dev` identifiers, including the dev signing fingerprint once it is known. Until then, links are tested through the `maxina://` scheme and the resolver unit tests.**
5. **Cache storage:** **Default: use N1's `KeyValueStore` (MMKV). If N1 is not merged, use the in-memory adapter (cache lost on restart, still fail-safe) and switch over when N1 lands.**
6. **Badge on iOS (Change 7):** **Default: server badge on the `notifyUser` path only, one count per recipient that has an `ios_native` token, behind the switch. The cron paths rely on the app-side refresh.**

## Planner responses — round 1
- **F1 [major] ACCEPTED.** Change 6's duplicate guard now ships disabled behind its own switch, `NATIVE_PUSH_APPILIX_GUARD_ENABLED` (default off, separate from `NATIVE_PUSH_DIRECT_ENABLED`).
  - Turning it on is its own Gate 2, with read-only evidence of how many members have an Appilix identity but no `Appilix %` row.
  - Until then, duplicates on an updated phone are accepted: a duplicate is the lesser harm than a lost push.
  - F8 now records why "no row" is not "no device" (`pushNotifications.ts:284-286`, `notifications.ts:42-44`).
  - Tests, Interfaces, Rollout 5–6 and Open question 2 are updated.
- **F2 [major] ACCEPTED.** The unread count is read only for recipients whose live tokens include an `ios_native` row: one count per such recipient, in the `notifyUser` path only.
  - The cron paths (`scheduled-notifications.ts`, `reminders-dispatch.ts`) **omit** the server badge and rely on the app-side refresh on foreground. This is the smaller change, chosen over a batched grouped count per tick.
  - All of it is behind `NATIVE_PUSH_DIRECT_ENABLED` (off).
  - Change 7, Tests, Out of scope and Open question 6 are updated.
- **F3 [major] ACCEPTED (safest variant).** N4 no longer touches `public/.well-known/*`, so N4-APP is not a web deploy and has no Gate 2.
  - Dev/test builds associate only with the G1 test web host. That host serves its own `.well-known` files. There is no association until G1 has a host, and production and staging hosts are rejected at build time.
  - Store-app universal links on vitanaland.com move to the Wave 3 store release.
  - The `.well-known` staging GETs are removed, and a Vitest byte-identity guard replaces them. The read-only `GET /api/v1/app-config` staging test stays (N4-GW).
  - Meta, Changes 13–14, Tests, Rollout 3 and Out of scope are updated. Old Open question 4 is replaced.
- **F4 [minor] ACCEPTED.** F8 is reworded:
  - only `registerAppilixDevice` (`:273-306`) sends `device_type` and `package_name`;
  - `registerTokenWithBackend` (`:247-266`, body at `:254-257`) sends neither.
- **F5 [minor] ACCEPTED with a correction.** Re-checked at `1e508fb3c`: the notifications mount is `index.ts:1342`, and `:1345` is the realtime-relay mount.
  - F11 now quotes the full mount text and notes what `:1345` holds, so it can be checked at any commit. If the partner meant a different line, please name the statement.
- **F6 [minor] ACCEPTED.** Change 4 now names the row-type change to `upsertDeviceToken` (`notifications-repository.ts:29-41`): `device_type?`, `app_version?`, written only for native types. Today's clients keep exactly today's upsert keys.
- **F7 [minor] ACCEPTED.** The gateway has no global limiter; public routes use per-route `express-rate-limit` (new F11a: `me-phone.ts:16,31`, `creators.ts:13,33`).
  - App-config adds a per-IP limiter (120/min), with a 429 test.
  - Change 3 states why the endpoint needs no more than that: static payload, 60 s public cache, a 10 s cache in front of the kill read.
- **F8 [minor] ACCEPTED.** The switch-off golden fixtures land in a separate first commit, green against the unmodified dispatch code, before any `dispatchPush` refactor. They are never regenerated in the same PR.

## Planner responses — round 2
- **F9 [minor] ACCEPTED.** `hasOnlyNativeAppDevices` short-circuits to `false` unless `NATIVE_PUSH_DIRECT_ENABLED` is on; test added (guard on, routing off → Appilix not suppressed).
