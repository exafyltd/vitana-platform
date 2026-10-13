# VTID-05162 — acceptance (Health Hub Phase 1 / B2)

Scope: the sparred plan's work package B2 (`plan-sparring.md`, Changes 0 and 6–9, shared interfaces S2–S5, S6, S8,
S10). B1 (VTID-05161) and B3 (VTID-05163) are separate VTIDs. Stacked on A2 (VTID-05159, PR #4105, which contains A1
#4102, B1 #4104 and D10 WP1 #4100); in the program merge order B2 comes after C1/C2 and is rebased forward then.
No file C1 owns is edited (in particular `services/health-store/consent-gate.ts` is untouched).

**What deploys:** gateway code, dark. `HEALTH_STORE_DUAL_WRITE_DEVICE` and `HEALTH_STORE_DUAL_WRITE_SELF_LOGGED` are
off by default and forced off on staging; the store's own `HEALTH_STORE_ENABLED` is also off; the three new tables do
not exist on Supabase. Every changed writer therefore behaves exactly as before. **Migration:**
`20261014100700_vtid_05162_health_features_v2.sql` is Aurora only (0T, then production after the cutover; never
Supabase). Nothing to apply at this change's Gate 2.

AC-1 Change 6, the spec as data (`services/health-features/feature-spec.ts`, frozen). The 18 Index feature keys equal
all four F7 copies, read from the files: the live Index function's data counts
(`20260424120000_pillar_tags_community_engagement.sql`), the streak helper (`20260423130000_vitana_index_compute_v3.sql`),
`routes/integrations.ts` and `pillar-agents/base-agent.ts`. Each key names its pillar, `origin` (device for exactly
the seven D6a keys), its S2 code(s) or null, the aggregation, the unit and the plausibility bounds (D6a
`COLUMN_FEATURES` for device keys). Null (never derived): `biomarker_glucose`, `biomarker_hba1c`, `macro_balance`,
`wearable_sleep_stages`, `wearable_stress`, and — no S2 code either — `journal_entry`, `hydration_log`. Every code
exists in the catalogue; no glucose/HbA1c code. The writer table names each writer's source kind, flag and
`source_record_id` rule (deterministic `<writer>:<date>:<code>[:n]` for diary, voice, manual, log_mood, log_vitals,
webhook daily metrics; per call for log_meal and the manual workout action; `<connector>:<external_workout_id>` for
webhook workouts).
TEST: test/health-features/feature-spec.test.ts (12 tests) — outputs/jest.txt

AC-2 Change 7, dual-write. Each writer calls `recordToHealthStore` only after its legacy write succeeded:
- W-diary at its single chokepoint `persistDiaryHealthFeatures` (its three call sites `routes/memory.ts`,
  `services/memory/diary.ts`, `orb-tools-shared.ts` all go through it), only for the writes whose row landed;
- W-voice `logHealthSignal`; W-manual `POST /integrations/manual/log`;
- W-orb `log_meal` (event, one meal record per call), `log_mood`, `log_vitals` heart rate, and `log_vitals`
  weight / blood pressure after their own legacy insert;
- the webhook daily-metrics and workout persists (keyed to the legacy `user_connections` row through B1's mirror);
- `wearable_log_workout` (per-action key).

A failed legacy write is never dual-written. The legacy response / tool result is byte-identical whatever the store
answers (skipped, `skipped_no_consent`, `STORE_PENDING`/`STORE_UNAVAILABLE`/`STORE_DISABLED`, or a rejection).
TEST: test/health-features/writers-dual-write.test.ts (13 tests); test/health-features/boundary.test.ts (every writer
site calls `recordToHealthStore` after its legacy write; static) — outputs/jest.txt

AC-3 `recordToHealthStore`: the writer's flag first (exact `'true'`, never on staging — off: no dependency is
touched); then the store flag; the zero-UUID tenant fallback is skipped; the member's own manual / voice / diary
source through `resolveHealthSource(create:true)`, a device cloud through B1's legacy-connection link
(`resolveHealthSourceByLegacyConnection`, added to the S6 module, same codes, never creates); then
`writeHealthSamples` (S3, `via:'internal'`, tz UTC, a new batch id per call). The consent gate is A's ingest: an
unconsented sample is counted `skipped_no_consent`; today every self-logged sample is refused
(`CONSENT_CATEGORY_MISSING`) until C1's `self_logged_health` key exists. Every `ok:false` and non-stored status is
counted; failures are logged with a code and emitted as OASIS `health.features.dual_write_failed` (rate-limited per
writer and code, codes and counts only). It never throws.
TEST: test/health-features/record-to-health-store.test.ts (27 tests, over the S10 fake store with the real ingest and
reader; the self-logged path end to end with C1's key simulated in the gate only)

AC-4 Change 8, the pending marker: after `writeHealthSamples` returns and before `recordToHealthStore` returns (so before
the caller responds) one `health_features_derivation_pending` row per changed member-day is upserted; the derivation
runs after the response and deletes the marker; a marker write failure is counted and not fatal; the nightly catch-up
derives every marker older than 5 minutes (OASIS `health.features.derivation_catch_up`, counts only) and counts an
attempt on failure.
TEST: record-to-health-store.test.ts "webhook daily metrics: stored, marker written before return, derivation after",
"a marker write failure …"; derive-daily-features.test.ts "the catch-up …", "a failed catch-up …"

AC-5 Change 8, the derivation. `deriveFeatures` is pure: member-stated (manual/voice/diary) beats device for value
keys, counts sum across sources, values outside the spec's bounds are dropped (never clamped), keys without a code
are never produced. `deriveAndStore` reads only through S4 `readDailyObservations` with `purpose:'feature_compute'`
(tz UTC), writes `health_features_daily_v2` rows with `metadata.source='derived_v2'`, `derivation_version`,
`source_kinds`, and replaces each derived date (rows the store no longer supports are deleted). If the store cannot
be read nothing is written or deleted and the marker stays. No-op on staging.
TEST: derive-daily-features.test.ts (golden fixtures: one member-day per writer class, multi-source precedence,
implausible values, never-produced keys; deriveAndStore) and record-to-health-store.test.ts (one golden member-day per
writer, from writer call to v2)

AC-6 S8: `rederiveMemberFeatures` is registered at gateway startup through `registerHealthStoreChangeHook`
(idempotent; A never imports B). After a withdrawal (`suppressHealthData`, no dates) it re-derives every date the
member has v2 rows for and deletes the rows whose observations were withdrawn; `unsuppressHealthData` restores them;
after a committed deletion it re-derives the affected dates. It never throws into the store; no-op on staging.
TEST: derive-daily-features.test.ts "rederiveMemberFeatures through the S8 change hook" (4 tests)

AC-7 Nightly "previous 2 days": the daily recompute batch (`processDailyRecomputeBatch`) gains a dark step (either
dual-write flag on, never on staging) that runs the marker catch-up on the run's first batch and derives the batch's
users for run date −2 and −1 within a 20 s budget. Its counts go to a separate `features_v2` field and never change
`ok`/`processed`/`failed`/`next_cursor`.
TEST: derive-daily-features.test.ts "the nightly pass derives the previous 2 days per user and stops at its budget",
"both passes are off without a dual-write flag and on staging"

AC-8 Boundary (S5): no file outside `services/health-store/**` names a `HEALTH_STORE_TABLES` table (imported from A);
B2's tables are named only inside `services/health-features/**`; `services/health-features/**` reaches the store
only through ingest (S3), reader (S4), catalogue (S2), change-hook (S8) and flags. The vtid-05025 commerce boundary
adds B2's tables to `HEALTH_TABLES` and bans importing `health-features/` from commerce modules.
TEST: test/health-features/boundary.test.ts; test/vtid-05025-commerce-health-boundary.test.ts

AC-9 Change 9, the migration: `health_features_daily_v2` (health_features_daily's columns — the union of VTID-01078,
VTID-01103 and the 2026-04-23 repair — plus `derivation_version text NOT NULL`, `source_kinds text[]` with a kind
CHECK), `health_features_daily_legacy_shadow` (the same columns, empty), `health_features_derivation_pending`
(unique per member-day, `attempts >= 0`). Service-role only (RLS on, no policy, no browser privilege), no FK to
`auth.users`, not in `erasure_registry`; `erase_user_data()` finds all three plus B1's `health_sources` by its catalogue
scan (dry-run counts; a real run empties them for that member only). Idempotent. Placement guard refuses a
Supabase-shaped database and leaves nothing behind; applies with `vitana.health_store_target='aurora'`. All three in
`aurora_only_tables`; the Aurora parity scripts carry `to_regclass`-guarded RLS and service_role grants.
TEST: scripts/ci/sql-tests/run-health-features-v2-test.sh (CI `SQL-HEALTH-FEATURES-V2.yml`; mutations: dropping the
v2 REVOKE, `derivation_version NOT NULL`, or the per-member-day key each turn it red); the A1/B1/erase SQL suites
unchanged; test/migrations/vtid-05162-health-features-v2-migration.test.ts; node scripts/ci/check-migration-drift.test.cjs
— outputs/sql-health-features-v2.txt, outputs/sql-a1-b1-suites-unchanged.txt, outputs/node-tests.txt

AC-10 Regression: existing suites stay green — `vtid-05089-wearable-features-bridge`, the webhook bridge route,
`health-log`, `health-depth-tools`, `action-executors`, diary, `vtid-05025`, `vtid-05161`, `health-store`,
`npm run test:support`, `test:operator`, `test:roles`. Full `npx jest`: the same 19 suites fail as on the A2 base
(local `libphonenumber-js` / pinpoint module gap), nothing new.
TEST: outputs/jest.txt, outputs/jest-full.txt, outputs/tsc.txt

## Not in this package (and why)
- **Activation.** Both dual-write flags stay unset everywhere. Device activation (D0) needs A's store live in
  production (Aurora) and D10 WP3; self-logged activation (D0s) needs C1's `self_logged_health` live. Each is its own
  config deploy and Gate 2 (plan Rollout 4).
- **`deriveAndStore(…, target='live')`, the cutover switch, the legacy shadow writes, the bridge skip and W-sql skip**
  are B3 (Changes 11–14). B2 creates the shadow table empty and supports `target='v2'` only.
- **W-sql and the two legacy ingest RPC routes, `log_biomarker`, partner lab results** are not re-routed (plan
  Change 7 "Not re-routed in B"; F9).
- **Per member-day `store_write_failed` persistence** for B3's classification: B2 counts failures per writer and code
  in process (`getHealthStoreDualWriteCounters`) and logs them; B3 decides how its classifier reads them.

## Decisions taken inside the plan
1. Every B2 store value is anchored at 00:00:00Z of the legacy row's `date` and written with tz `UTC`; the derivation
   reads with tz `UTC`. So the store's local date is exactly the legacy `date` the Index counts (webhook workouts and
   the workout action keep their real start time, whose UTC date is the day D6a counts them on).
2. `journal_entry` and `hydration_log` have no S2 code, so they are `null` in the spec (legacy-only, like the five
   keys the plan names). Deriving `hydration_log` from `water_intake` would add a row legacy writers never produce.
3. Code choices for keys with several candidates: `wearable_heart_rate` ← `resting_heart_rate` then `heart_rate`
   (device resting HR first; ORB/manual spot HR is written as a one-sample `heart_rate` series item);
   `wearable_hrv` ← `hrv_rmssd` then `hrv_sdnn` (webhook `hrv_avg_ms` → `hrv_sdnn`, `hrv_rmssd_ms` → `hrv_rmssd`).
4. Counts with replace semantics (diary / manual `meal_log` = N): records `…:meal:1..N`, and deletions of
   `…:meal:N+1..10`, so a lower count replaces a higher one. log_meal writes one record per call.
5. A webhook day's `workout_count > 0` becomes one `workout` record (`…:<date>:workout`, value = the day's workout
   minutes, detail `{workout_count}`) so the day has a workout row exactly where D6a would; a webhook workout without
   `external_workout_id` is keyed by its start time.
6. `wearable_log_workout` (provider `manual`) writes as the member's `manual` source, on the device flag as the plan
   says; it is therefore refused (`CONSENT_CATEGORY_MISSING`) until C1's key exists. Its per-call id is the action id.
7. The diary dual-write sits in `persistDiaryHealthFeatures`, the one function its three call sites share, so all three
   are covered by one call after the legacy writes.
8. `rederiveMemberFeatures` runs whatever the dual-write flags say (a withdrawal must reach derived data), never on
   staging; when A names no dates it re-derives every date the member has v2 rows for.
9. A device-cloud source is found through B1's `legacy_user_connection_id` link; a small additive helper
   `resolveHealthSourceByLegacyConnection` sits next to S6 (S6's own signatures are unchanged).
10. The nightly pass runs inside the existing daily recompute batch (no new route or EventBridge rule): catch-up on
    the run's first batch, then run date −2/−1 for the batch's users, capped at 20 s per batch.

## Route evidence
B2 adds no route and no mount. Its changes in `routes/` (`connector-webhooks.ts`, `integrations.ts`) are inside existing
handlers, and its `index.ts` change only registers the S8 hook. The route mount in the stacked diff against `main` is
A2's (`/api/v1/health/internal`, evidence in `docs/validation/VTID-05159/acceptance.md`), repeated here because this
PR is stacked on it:
ROUTE_MOUNT: `services/gateway/src/index.ts` — A2's `mountRouterSync(app, '/api/v1/health/internal', healthStoreInternalRouter, …)`; B2 mounts nothing (the touched routers `/api/v1/connectors` and `/api/v1/integrations` are unchanged mounts).
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info
CURL_PROOF: read-only, after the staging deploy: `curl -s -o /dev/null -w '%{http_code} %{content_type}' https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info` must answer `200 application/json`; `GET /api/v1/wearables/providers` answers `200 application/json`; `GET /api/v1/integrations` and `/api/v1/wearables/connections` with an invalid bearer answer `401` JSON. No POST is ever sent to staging (the dual-write flags are forced off there; every write path is proven in Jest).

## OASIS
OASIS_PROOF: two new event types declared in `services/gateway/src/types/cicd.ts`, `vtid: 'VTID-05162'`, `source: 'health-features'`, `actor_role: 'system'`, payloads with codes and counts only (never a member id, never a health value): `health.features.dual_write_failed` (`{writer, code, suppressed_since_last, …counts}`, rate-limited per writer+code; asserted in test/health-features/record-to-health-store.test.ts "webhook workouts are keyed … a missing connection is a counted failure" and "OASIS failure events are rate-limited per writer and code"; an emitter that throws never fails the caller, "a throwing writer, resolver, repository or emitter gives a result") and `health.features.derivation_catch_up` (`{markers_found, members, derived_members, failed_members}`; asserted in derive-daily-features.test.ts "the catch-up derives markers older than 5 minutes only, and reports counts on OASIS"). Both are emitted only with a B2 flag on, never on staging.
