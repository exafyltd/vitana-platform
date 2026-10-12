# VTID-05089 — acceptance criteria (Health Hub D6a: wearable features bridge, flag-gated)

AC-1 `find_perfect_product` no longer reads `vitana_index_scores`: without a `pillar` argument it applies no `pillar_tags` filter; with one it filters by the named pillar only. `find_perfect_practitioner` keeps its Life Compass goal and reads no Index either. The tool description and `pillar` parameter text say the pillar is used only when the member names one. Unconditional (not behind the flag).
TEST: npx jest test/vtid-05025-commerce-health-boundary.test.ts -t "VTID-05089"

AC-2 The commerce source scan also bans `vitana_index_scores`, `vitana_pillar_agent_outputs` and any import of `wearable-features-bridge(-repository)` from every commerce module.
TEST: npx jest test/vtid-05025-commerce-health-boundary.test.ts -t "source scan"

AC-3 The voice payload changes only by the `find_perfect_product` description: the VTID-04542 manifest/snapshot differ only in tool-catalog hash/bytes (no instruction hash changed), and the A0.1 characterization snapshots differ only in the description lines.
TEST: npx jest test/orb/latency test/orb/live/characterization

AC-4 Flag matrix: `isWearableFeatureBridgeEnabled(env)` is `env.WEARABLE_FEATURE_BRIDGE_ENABLED === 'true' && env.VITANA_ENV !== 'staging'`. Absent on production → off; `'true'` on production → on; `'true'` on staging → off; `'false'`, `'TRUE'`, `'1'` → off. When off, the bridge makes zero reads, writes and RPC calls.
TEST: npx jest test/vtid-05089-wearable-features-bridge.test.ts -t "isWearableFeatureBridgeEnabled"

AC-5 Mapping: `sleep_minutes`→`wearable_sleep_duration` (min), `sleep_efficiency_pct`→`wearable_sleep_efficiency` (%), `hrv_avg_ms ?? hrv_rmssd_ms`→`wearable_hrv` (ms), `resting_hr`→`wearable_heart_rate` (bpm), `steps`→`wearable_steps`, `vo2max`→`vo2_max` (ml/kg/min), `max(workout_count, wearable_workouts rows that day)`→`wearable_workout` (count, only if > 0). Nulls and values outside the plausibility bounds are dropped, never clamped; `wearable_sleep_stages`/`wearable_stress` are never written. Across providers, per column the latest `updated_at` wins with its provider.
TEST: npx jest test/vtid-05089-wearable-features-bridge.test.ts -t "mapDailyMetricsToFeatures"

AC-6 Writes: rows carry `confidence 0.9`, `sample_count`, `metadata {source:'wearable_bridge', provider, metric_date}`. Insert ignores existing rows; only rows with `metadata.source = 'wearable_bridge'` are updated, so a member's diary/voice/manual row is never replaced. Running twice gives the same rows. Only this member in this tenant is read.
TEST: npx jest test/vtid-05089-wearable-features-bridge.test.ts -t "idempotent|never overwrites|writes the mapped rows|only reads this member"

AC-7 A test/service account (`service_bot_accounts` or `notification_test_actors`) is skipped: zero writes, zero RPC calls.
TEST: npx jest test/vtid-05089-wearable-features-bridge.test.ts -t "excluded test/service account"

AC-8 `health_compute_vitana_index_for_user(p_user_id, p_date=today UTC)` runs exactly once per bridge call that wrote rows.
TEST: npx jest test/vtid-05089-wearable-features-bridge.test.ts -t "recomputes the Index exactly once"

AC-9 Route: after the event loop the webhook calls the bridge once per distinct user with the dates whose upsert succeeded (daily metric_date, workout started_at UTC date); flag off/staging → never called; no tenant (no connection) → not called; the bridge throwing or failing never changes the `{ok:true, processed, skipped}` response.
TEST: npx jest test/routes/vtid-05089-connector-webhooks-bridge.test.ts

AC-10 No regression in the existing webhook/connector suites; the gateway type-checks.
TEST: npx jest test/routes/connector-webhooks.test.ts test/vtid-05031-webhook-verification.test.ts test/vtid-05030-connection-tokens.test.ts; npx tsc --noEmit -p .

OASIS_PROOF: each bridge call that runs emits exactly one `health.wearable_features.bridged` (status info, vtid VTID-05089, payload `feature_keys, dates, providers, rows_written, days, index_recomputed` — no health value), or on any failure `health.wearable_features.bridge_failed` (status error, payload `error_code, dates, days` — no raw values). Both types are in `CicdEventType`. The pre-existing per-event `connector.wearable.*.recorded` mirror is unchanged and out of scope.
TEST: npx jest test/vtid-05089-wearable-features-bridge.test.ts -t "no numeric health value|bridge_failed|exception"
