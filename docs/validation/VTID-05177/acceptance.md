# VTID-05177 — acceptance (Native app Wave 1, N4-GW)

Scope: the sparred plan's package N4-GW (`plan-sparring.md`, Changes 1–7 and their Tests, plus the planner responses of
rounds 1–2). N4-APP (vitana-v1) is a separate PR under its own VTID.

**What deploys:** gateway code that ships dark.
- `GET /api/v1/app-config` is new and answers every flag `false`, minimum version `0.0.0`.
- Push dispatch is unchanged while `NATIVE_PUSH_DIRECT_ENABLED` and `NATIVE_PUSH_APPILIX_GUARD_ENABLED` are unset — which
  they are in every task definition; this VTID makes no task-definition change.
- The token route stores `device_type` / `app_version` only for `ios_native` / `android_native`, which no client sends
  yet (N4-APP's push client has only a Noop provider until N4-FCM after G2).

**No migration.** Read-only check before code (plan F9), production Supabase, 2026-10-13:
`information_schema.columns` for `public.user_device_tokens` lists `device_type text` and `app_version text`
(migration `20260427180000_vtid_02003_phase_5a_tier2_schema.sql:400-410` applied); `select device_type, count(*)` →
one group, `device_type = NULL` (134 rows) — no existing row carries a native type. Aurora column presence was not
checkable from the session; the gateway reads/writes this table through Supabase PostgREST today.

ROUTE_MOUNT: services/gateway/src/routes/app-config.ts → router.get('/', ipLimit, …) (new, no auth); mounted in src/index.ts via mountRouterSync(app, '/api/v1/app-config', appConfigRouter, { owner: 'app-config' }) (once, next to the auth-free admin-health mount); claimed in orb/developer/domain-atlas.ts (infra domain, `/^app-config$/`)
FINAL_URL: GET {gateway}/api/v1/app-config
CURL_PROOF: staging only, read-only, by STAGING-VERIFY (`staging-tests.json` test 1): `GET https://preview-aws-gateway.vitanaland.com/api/v1/app-config` → 200 `application/json`, `ok:true`, `schema_version:1`, every flag `false`, `min_supported_version:"0.0.0"` on both platforms. Never run against production. Local proof: Jest AC-1.
OASIS_PROOF: none — no new OASIS event. The endpoint carries no member data and push routing emits nothing new; the reminder path's existing `reminder.fcm_fallback` event is unchanged with the switches off (golden fixtures). Kill switches are armed through the existing governance controls API, which already audits and emits `governance.control.updated`.

## Acceptance criteria

AC-0 **Golden fixtures first (sparring R1-F8).** Commit 1 (`501385f2f`) adds the switch-off golden fixtures and their
test, recorded from the unmodified dispatch code at `origin/main` `d577b319d`, green on that commit before any dispatch
code changed. 130 scenarios: `notifyUser`, `POST /push-dispatch` and `scheduleReminderFcmPush` × 13 token mixes (none,
web, Appilix, web+Appilix, native iOS, native Android, native iOS+Appilix+web, iOS+Android native, signed out,
lost phone, stale web, FCM error, stale native) × URL/no URL × Appilix delivered/no device (reminders always carry a
URL). Each pins every Supabase query chain (table, methods, arguments), FCM message, Appilix request (URL + form body),
OASIS event and the result, in order. The fixture file is unchanged by every later commit.
TEST: test/services/native-push-golden.vtid-05177.test.ts (2 tests)

AC-1 `GET /api/v1/app-config`: no auth; `200 { ok, schema_version: 1, generated_at, ttl_seconds: 300, platforms:
{ ios, android } }` with `min_supported_version '0.0.0'`, `recommended_version null`, `update_url null` and
`push_enabled`, `health_sync_enabled`, `orb_native_enabled` all `false`; `Cache-Control: public, max-age=60`; no
`user_id` / `email` / `tenant_id` anywhere in the body (deep key scan).
TEST: test/app-config.test.ts "GET /api/v1/app-config"

AC-2 Kill switches: `system_controls` rows `native_app.kill.<ios|android|all>.<flag>` that are enabled and unexpired
force that flag `false`; `all` covers both platforms; expired, disarmed, unknown-platform, unknown-flag and malformed
keys are ignored; a kill never turns a flag on and never changes a version (proved against an all-on base). The read is
a read-only REST GET (`key=like.native_app.kill.*`, 3 s timeout) returning `{rows}|{error}`, cached 10 s; a failed read
is not cached.
TEST: "kill switches (system_controls native_app.kill.*)", "kill repository (read-only REST)", "the kill read is cached for 10 s"

AC-3 A kill-read failure answers `503 { ok:false, error:'config_unavailable' }` with no `platforms` and
`Cache-Control: no-store` — the endpoint never answers with flags it could not check.
TEST: "a kill repository error answers 503 config_unavailable with no platforms"

AC-4 Per-IP `express-rate-limit`, 120 requests/min, `standardHeaders`: request 121 from one IP within a minute → 429
JSON `{ ok:false, error:'TOO_MANY_REQUESTS' }` (sparring R1-F7).
TEST: "request 121 from one IP within a minute gets 429 JSON"

AC-5 Mounted exactly once through `mountRouterSync` with owner `app-config`; the `infra` domain claims `app-config`,
lists `system_controls` in `tables` and `native_app.kill.*`, `NATIVE_PUSH_DIRECT_ENABLED`,
`NATIVE_PUSH_APPILIX_GUARD_ENABLED` in `flags`; the VTID-04560 atlas drift guard stays green.
TEST: "mounting and atlas"; `npm run test:roles`

AC-6 Token route (`POST /api/v1/notifications/token`, first coverage for the route): today's web body and today's
Appilix body (`device_type:'appilix'`, `package_name`) make exactly today's three queries — takeover, upsert with
exactly today's keys (no `device_type` / `app_version`), prune; any other `device_type` is ignored. `ios_native` /
`android_native` store their type and `app_version` with a server-set label `native-ios <v>` / `native-android <v>`
(client label ignored) that matches neither `/^Appilix /` nor `/appilix|\bApp\d+\b/i`; a bad `app_version` (over 32
characters or outside `[0-9A-Za-z.+-]`) is stored as `null`. A native registration while `NATIVE_PUSH_DIRECT_ENABLED`
is off logs `[Notifications] native token registered while NATIVE_PUSH_DIRECT_ENABLED is off`.
TEST: test/routes/notifications-token.vtid-05177.test.ts (20 tests)

AC-7 Switch off (`NATIVE_PUSH_DIRECT_ENABLED` unset, or any value but exactly `true`): all three sites route through the
single `dispatchPush()` (`services/push-routing.ts`) and make exactly the recorded calls — AC-0 green on the final
commit; also green with only the guard switch on and with mistyped values (`TRUE`, `1`).
TEST: native-push-golden; native-push-routing "switches that must leave today's behaviour untouched"

AC-8 Switch on: native tokens (`device_type` ios_native/android_native) get a first, direct FCM pass at every site,
URL or not, whatever Appilix does; then each site's legacy logic runs over legacy tokens only and equals the switch-off
behaviour over the same legacy tokens call for call (all 130 scenarios bar one documented edge, below); the
"FCM delivered zero" fallbacks count legacy sends only; stale native tokens are revoked (`fcm_invalid`). Each site's
own legacy policy is a parameter (suppression rule, deep-link FCM exclusion), so the F4b asymmetry of
`/push-dispatch` is kept, not fixed.
TEST: test/services/native-push-routing.vtid-05177.test.ts "switch ON"

AC-9 Badge: only on the `notifyUser` path, only on `ios_native` sends, `apns.payload.aps.badge` from one
`countUnreadNotifications` read per recipient that has a live `ios_native` token (never for others, never per token);
left out when the count fails; `android_native` gets none; the two cron paths read no count and send no badge.
TEST: "badge (notifyUser only, ios_native only)"

AC-10 Duplicate guard (`NATIVE_PUSH_APPILIX_GUARD_ENABLED`, default off): inactive (no query) while the guard switch is
off, even with routing on; `hasOnlyNativeAppDevices` returns `false` without a query unless routing is on (sparring
R2-F9: guard on + routing off + native token → Appilix not suppressed, every golden holds); with both on, Appilix is
suppressed only for a user with a live native token and no live `Appilix %` token, URL or not, at all three sites.
TEST: "duplicate guard"; "guard on + routing off …"; "hasOnlyNativeAppDevices short-circuits …"

AC-11 Existing suites green: `notification-device-ownership`, `vtid-04320-reminders-dispatch`, the three
`scheduled-notifications-*` tests, `vtid-04962-push-outcome`, `vtid-04962-push-dispatch-outcome` (these mock
`notification-service` and still observe identical `sendPushToUser` / `sendAppilixPush` calls through the router),
every other test importing `notification-service`; `npm run test:support`, `test:operator`, `test:roles`;
`tsc --noEmit`. Two source-contract tests were re-pointed, not loosened (see Decisions).
TEST: outputs in the PR body

## Decisions taken
1. **`dispatchPush` lives in `services/push-routing.ts`, not inside `notification-service.ts`.** Seven existing suites
   mock `notification-service` wholesale; with the router inside that module they would have lost it and needed
   rewrites. In its own module the real router runs in those suites unchanged, against their mocked
   `sendPushToUser` / `sendAppilixPush` — a stronger proof that switch-off calls are unchanged. The token-class
   vocabulary (`isNativeDeviceType`, `tokenClass`, `iosBadge`) stays in `sendPushToUser`. The env switches are in a
   dependency-free `native-push-flags.ts` so the token route does not load the FCM sender.
2. **Suppression read point.** Each site keeps its read point relative to the FCM sends: the deep-link sites read it
   before any FCM send (now also before the native pass, so a stale native token revoked by the native pass cannot flip
   that push's Appilix decision); reminders read it after the FCM sends as before, so a native token found stale there
   counts (the member's only device just proved dead). Documented and tested ("suppression is read at the same point
   …"); this one edge is the scenario excluded from AC-8's legacy-equality sweep.
3. **Source-contract tests re-pointed:** `vtid-04674-notification-controls-wiring` (the admin-switch / delivery-decision
   checks now look for `dispatchPush(` instead of `sendPushToUser(`; the "no other code path pushes directly" scan also
   counts `dispatchPush(` and exempts the router module like `notification-service.ts`; the allowed offender list is
   unchanged) and `vtid-04883-community-ranking` (anchor moved from the old `sendPushToUser(...)` call to the
   `dispatchPush({` call; the shadow call must still come after it). No assertion was loosened.
4. **`fetchLiveDeviceTokensForUser` takes `{ withDeviceType }`;** the select string is today's unless a native routing
   pass asks for `device_type`. The guard reads a new `fetchLiveDeviceTypesForUser` (user-scoped, like Appilix's
   identity).
5. **`app_version` without a valid value** stores `null` and the label is `native-ios` / `native-android` without a
   version.
6. **Atlas:** besides the plan's entries, the `infra` domain also lists `NATIVE_PUSH_APPILIX_GUARD_ENABLED` and the new
   service files under `code`.
7. **No staging write probe** of any kind (not even a rejected POST to the token route): staging tests are the
   app-config GET and build-info only.
