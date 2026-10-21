# Plan sparring record — VTID-05089 (Health Hub D6a)

- **Parent program:** VTID-05020 (Health Hub plan r7, §1 D6).
- **Sparring session:** `plan_sparring_sessions.id = ace9afcc-ed19-43c2-9ad8-3abb7733c448`. The VTID was allocated with `p_sparring_id`.
- **Partner:** `plan-sparring-partner` agent (read-only, independent). **Rounds:** 3. **Verdict:** CONVERGED.
- **Plan hashes:** round 1 `06e444acd5289d9e2343e350965765b3bcc1c46876a193db02a9cf3be0407b8f`, **final `0435bf9303b6607e63dda836c2e4e3e12e18290e344a1ab68bb409c596a419ff`**.
- **Owner approval:** d.stevanovic@exafy.io in the Claude Code session, 2026-10-12 — "Yes approved" (Gate 1 for D6a, D9 and D10).

## Round 1 — NOT CONVERGED

| # | Sev | Finding | Answer |
|---|-----|---------|--------|
| F1 | major | Bridge rows reach the LLM system instruction with real health values via the nightly consolidator → `biometric_trends` → `agent-profile-service`. | Accepted: the flag stays OFF until D10 WP3 is live; enabling makes the bridge a consent-gated D10 enforcement point. Q2 resolved by the planner. |
| F2 | minor | Distinguish the bridge's value-free event from the pre-existing full-payload mirror. | Accepted. |
| F3 | minor | Use `sharedDbLoopAllowed`. | Accepted, then reverted in round 3 (see F8). |
| F4, F5 | minor | Key count; snapshot regeneration. | Confirmed, no change. |
| F6 | major | Q2 consequences incomplete. | Accepted (same as F1). |
| F7 | minor | Confidence has no runtime effect today. | Accepted, documented. |

## Round 2 — NOT CONVERGED

| # | Sev | Finding | Answer |
|---|-----|---------|--------|
| F8 | blocker | `sharedDbLoopAllowed` is true on every non-staging env regardless of the flag — the bridge would be ON in production by default. | Accepted: explicit `flag === 'true' && VITANA_ENV !== 'staging'`; tests pin the matrix. |

## Round 3 — CONVERGED

No findings.

## Implementation decisions (recorded for Gate 2)

1. Two A0.1 characterization snapshots and the VTID-04542 voice-payload snapshot were regenerated; only the `find_perfect_product` description changed.
2. No OASIS event when the flag is off or the member is an excluded test/service account (one event per call that actually runs).
3. The Index RPC is skipped when there is nothing to write.
4. An implausible value counts as absent, so another provider's plausible value can win the merge.
5. `tool-manifest.json` description of `find_perfect_product` corrected (no longer "fuses pillar deficits").
6. Out of scope, recorded as follow-ups: `discovery-tools` `tool_find_perfect_match` still reads the Index for a people-match default (community, not commerce); `_getCompassGoal` keeps the pre-existing `life_compass.current_goal` read although VTID-03022 names `primary_goal`.

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard. Gateway code only. **No migration.** The code ships dark: the bridge is off unless a flag is exactly `'true'`, and it is always off on staging.
- **Split.** The full D6 ("poll scheduler + fetchData + features + Index") is too large and partly premature. This plan delivers **D6a** only: wearable data that already lands (vendor webhooks into `wearable_daily_metrics`/`wearable_workouts`) is turned into `health_features_daily` rows and triggers a Vitana Index recompute. **D6b**, the scheduler that calls `fetchData` for the polling connectors (Oura, Fitbit, Strava) with token refresh, is deferred to Phase 2 of the program (outline in "Not in scope"). Three reasons. Those three connectors are seeded `enabled = FALSE` (Fact 13). Their direct connectors are frozen by the program (Fact 16). And `user_connections` held zero wearable rows when VTID-05030 checked (Fact 14).
- **Behaviour changes (only when the flag is on in production):**
  1. A verified vendor webhook that writes daily wearable metrics or workouts also writes up to 7 Index-relevant `health_features_daily` rows per member-day. It then recomputes that member's Vitana Index once per webhook request.
  2. The marketplace voice tool `find_perfect_product` no longer defaults its product filter to the member's weakest Vitana Index pillar. The pillar now applies only when the member names it. This change is **unconditional, not behind the flag**. It closes a commerce path to the Index *before* the Index can contain device-derived data (Fact 11).
- **Files in scope (vitana-platform only):**
  - NEW `services/gateway/src/services/wearable-features-bridge.ts`: the mapping, merge, plausibility check, flag check, writes and OASIS event.
  - NEW `services/gateway/src/services/wearable-features-bridge-repository.ts`: data-access seam, same pattern as `connector-webhooks-repository.ts`.
  - `services/gateway/src/routes/connector-webhooks.ts`: collect the (user, tenant, date) set it persisted and call the bridge once after the event loop.
  - `services/gateway/src/types/cicd.ts`: 2 OASIS event types.
  - `services/gateway/src/services/orb-tools-shared.ts`: in `tool_find_perfect_product` and its helper, remove the Index read.
  - `services/gateway/src/orb/live/tools/live-tool-catalog.ts`: correct the `find_perfect_product` description and the `pillar` parameter text (English intent, not member copy).
  - `services/gateway/test/orb/latency/__snapshots__/vtid-04542-voice-payload-identity.test.ts.snap`: regenerated for the description change only.
  - Tests: NEW `services/gateway/test/vtid-<D6a>-wearable-features-bridge.test.ts`, NEW `services/gateway/test/routes/vtid-<D6a>-connector-webhooks-bridge.test.ts`, EXTEND `services/gateway/test/vtid-05025-commerce-health-boundary.test.ts`.
  - `docs/validation/<VTID>/{plan-sparring.md,staging-tests.json,acceptance.md}`, `docs/programs/health-hub/STATUS.md` (one row plus the D6b deferral).
- **Migrations:** none. All columns already exist (`health_features_daily` after the 2026-04-23 repair, Fact 5), and so does the service-role Index RPC (Fact 7).

## Facts (origin/main)
1. **`wearable_samples` has two conflicting definitions with the same timestamp.**
   - `20251231000000_vtid_01078_health_brain_phase_c1.sql` L100-110 creates it as `provider, metric, ts, value, unit, raw_json`. Sorted by name, this file runs first.
   - `20251231000000_vtid_01103_health_compute_engine.sql` L17-30 uses `CREATE TABLE IF NOT EXISTS` with `sample_type, recorded_at, source`, so it is a no-op.
   - The production restore scripts carry only the 01078 indexes (`services/postgrest-aurora-proxy/aurora-restore-03-indexes.sql` L1355-1356: `metric, ts`) and only an `id` default (`aurora-restore-01-defaults.sql` L2671).
   - The live writers use the 01078 columns (`orb-tools/health-depth-tools-repository.ts` L75-80 inserts `provider, metric, ts`).
2. **`health_compute_features_daily` (01103 L163-275) cannot serve D6.**
   - It is `auth.uid()`-scoped (L176-183), so no service job can call it per member.
   - It reads `wearable_samples.sample_type/recorded_at` (L196-213), which the live table does not have (Fact 1). *Inferred*: it errors at runtime with "column sample_type does not exist".
   - It writes `'wearable_' || sample_type` (L221), and those keys do not match the Index's keys (Fact 6, e.g. `wearable_sleep` vs `wearable_sleep_duration`).
   - It also reads `biomarker_results` (L230-258), so the D6 wording "reads only wearable_samples" is slightly off.
   - Its only caller is the member-JWT route `POST /api/v1/health/recompute/daily` (`routes/health.ts` L342-360; `routes/health-repository.ts` L34).
3. **Webhook ingest is the only live wearable write path.**
   - `routes/connector-webhooks.ts` L150-176 upserts `wearable_daily_metrics` (conflict key `user_id,provider,metric_date`, `connector-webhooks-repository.ts` L33-35).
   - L178-196 upserts `wearable_workouts` (`user_id,provider,external_workout_id`, repository L37-39).
   - L202-209 mirrors every event to OASIS with the full health payload.
   - Tenant comes from `user_connections` (L112-124). Verification fails closed when a secret is unset (header L13, VTID-05031).
4. **`wearable_daily_metrics` schema:** `20260417000000_vtid_02100_connector_framework.sql` L115-160 (sleep, HR/HRV, steps, workouts, vo2max, body; `UNIQUE (user_id, provider, metric_date)`). It has service-role write and owner-select RLS (L279-285). The `wearable_rollup_7d` view is at L169-187. Under Terra/Vital the row's `provider` is the underlying device vendor (`connectors/wearable/terra.ts` L280-300; `vital.ts` L214-250). So one member-day can have several rows.
5. **`health_features_daily`:** unique `(tenant_id,user_id,date,feature_key)` (01078 L118-128). `feature_unit, sample_count, confidence, metadata, updated_at` were added by `20260423210000_health_features_daily_schema_repair.sql` L18-23. TS writers upsert on that key: `diary-health-extractor.ts` L282-320 (`metadata.source='diary_extractor'`, last write wins), `voice-tools/health-log-repository.ts` L27-42, `orb-tools/health-depth-tools.ts` L268-280 (writes `wearable_heart_rate` from voice), `routes/integrations-repository.ts` L84.
6. **Vitana Index (v3, 5 pillars) reads only `health_features_daily` for its "connected data" component.**
   - `health_compute_vitana_index_for_user` (latest: `20260424120000_pillar_tags_community_engagement.sql` L389ff., data block L524-552) counts rows in the last 7 days from `CURRENT_DATE` per pillar key set (≥1 → 15, ≥4 → 25, ≥11 → 40).
   - Exercise keys: `wearable_heart_rate, wearable_steps, wearable_workout, vo2_max`. Sleep keys: `wearable_sleep_duration, wearable_sleep_efficiency, wearable_hrv, wearable_sleep_stages`.
   - The streak bonus counts the same keys per day (`20260423130000_vitana_index_compute_v3.sql` L71-100).
   - The same key lists appear in `routes/integrations.ts` L45-47 and `pillar-agents/base-agent.ts` L16-18.
7. **The Index recompute RPC for a job is `health_compute_vitana_index_for_user(p_user_id, p_date)`.** It is granted to service_role only (`20260423140000_vitana_index_compute_for_user.sql` L301-304) and called by every TS writer (e.g. `voice-tools/health-log-repository.ts` L59-61).
8. **A daily Index recompute already exists.** EventBridge `gateway-daily-recompute` runs at 02:00 UTC (`scripts/aws/setup-eventbridge-cron-migration.sh` L185) and calls `POST /api/v1/scheduler/daily-recompute` (`routes/scheduler.ts` L61). Its `index` stage calls `scheduler_vitana_index_compute_daily` (`daily-recompute-service.ts` L228), which wraps `health_compute_vitana_index_for_user` (`20260528120000_BOOTSTRAP_vitana_index_daily_stage.sql` L24-80). A missed immediate recompute therefore self-heals within 24h.
9. **`fetchData` is never called.** It is declared at `connectors/types.ts` L176 and implemented in `fitbit.ts` L162-239 (one day per call, sleep/activity), `oura.ts` L118-220 (sleep/activity/workouts, default 7 days), `strava.ts` L134-180 (workouts) and as a stub in `terra.ts` L231-237. `git grep fetchData` finds no caller.
10. **There is no token-refresh path for `user_connections`.** `refreshToken` is called only in `connectors/runtime/dispatcher.ts` L106, for `social_connections`. Wearable tokens are stored sealed (`routes/wearables.ts` L222-241; `lib/connection-token-crypto.ts` L37-55; `openToken` returns null for anything not sealed). `user_connections` already has `sync_cursor, last_sync_at, last_error, token_expires_at` (connector framework L61-75).
11. **A commerce path reads the Index today.**
    - `tool_find_perfect_product` (`services/orb-tools-shared.ts` L4580-4593) filters `products_catalog` by `pillar_tags` using `askedPillar || ctx.weakest_pillar`. The weakest pillar comes from `vitana_index_scores.pillars` in `_getWeakestPillarAndGoal` (L4545-4577).
    - `tool_find_perfect_practitioner` (L4647ff.) uses only `compass_goal` from the same helper.
    - The tool description says "Fuses their weakest Vitana Index pillar" (`orb/live/tools/live-tool-catalog.ts` L684-705), and the manifest marks the tool `category: marketplace` (`services/tool-manifest.json` L1900-1902).
    - The VTID-05025 boundary test does not cover this. Its commerce list (`test/vtid-05025-commerce-health-boundary.test.ts` L215-233) has no `orb-tools-shared.ts`, and its `HEALTH_TABLES` regex (L241) has no `vitana_index_scores`.
12. **Other Index readers stay in the member's own health/community domain.** `user-health-context.ts` sets `vitana_index_snapshot: null` (L260). Commerce modules read neither `vitana_index_scores` nor `health_features_daily` (git grep). `index-gap-analyzer.ts` emits `domain: 'health' | 'community'` (L99-182). News feed "Index Spotlight" shows `score_total` only for `index_spotlight_consent = true` members (`routes/news-feed-repository.ts` L24-40). `community-member-ranker.ts` L515-518 already excludes `health_features_daily`.
13. **Registry seeds:** `terra` and `vital` enabled TRUE. `fitbit`, `oura` and `strava` enabled FALSE (`20260417000100_..._registry_seed.sql` L8-33; `20260417010000_..._registry_update.sql` L9-28). Live values must be confirmed (Q1).
14. **No stored wearable connections.** VTID-05030 sparring Fact 3 (`docs/validation/VTID-05030/plan-sparring.md` L63-64) found `user_connections` has 1 row (connector `claude`) and 0 tokens. `docs/programs/health-hub/STATUS.md` L32 says "Zero stored tokens today". Webhook secrets are not wired in either task definition (STATUS L18), so deliveries are currently rejected.
15. **Patterns to reuse:**
    - Production-only job flag: `services/connector-webhook-log-purge.ts` L8-20 and `index.ts` L1776-1795.
    - Staging guards: `env.ts` L20 (`isStaging`) and L30-33 (`sharedDbLoopAllowed`). The onboarding coach refuses on staging with 409 (`routes/scheduled-notifications.ts` L1653-1662).
    - Test/service account exclusion: `lib/excluded-test-service-accounts.ts` L23 (`fetchExcludedTestServiceAccountIds`).
    - OASIS types: `types/cicd.ts` L937-951.
    - Fake Supabase for Jest: `test/services/voice-tools/supabase-mock.ts`.
16. **Program placement.** D6 appears only in the defect list (`health-hub-plan-v2.md` L44). It is not part of the Phase 0 row (L167). Phase 1 makes `health_features_daily` derived from observations and re-routes all writers, with a ≥14-day Index dual-compute (L122-127). Phase 2 owns "scheduler/webhooks" via one EU aggregator (L172). The direct connectors fitbit/oura/strava are "frozen, not extended" (L99). The device-data → commerce ban is §2b (L85).

- **Q1/Q3 verified read-only by the planner on the live database (2026-10-12):**
  - `user_connections`: 0 rows for fitbit/strava/oura/terra/vital, 0 with tokens; `wearable_samples`: 0 rows.
  - `connector_registry`: vital and terra enabled, strava/fitbit/oura disabled.
  - Live `wearable_samples` columns are `id, tenant_id, user_id, provider, metric, ts, value, unit, raw_json`. The live `health_compute_features_daily` reads exactly `tenant_id, user_id, ts, metric, value` (CTE `wearable_daily`), so there is **no column mismatch** (Q3 resolved: the suspected mismatch does not exist on the live database).

## Changes
1. **Close the Index → commerce path first (unconditional).**
   - In `tool_find_perfect_product`, the target pillar becomes `askedPillar` only.
   - Replace `_getWeakestPillarAndGoal` with `_getCompassGoal`, which reads `life_compass` only. Both tools keep their compass-goal rationale.
   - No `vitana_index_scores` read remains in either tool.
   - Update the `find_perfect_product` description and the `pillar` parameter text: "OPTIONAL — only when the member names a pillar".
   - Regenerate the VTID-04542 voice-payload snapshot. Only the description lines may differ.
   - Spoken result text is unchanged. No new hardcoded speech (NEVER rule 41).
2. **New `wearable-features-bridge.ts`.** Exports:
   - `isWearableFeatureBridgeEnabled(env)` = `env.WEARABLE_FEATURE_BRIDGE_ENABLED === 'true' && env.VITANA_ENV !== 'staging'` (round-2 F8). The feature's own flag is the primary gate, so the bridge is dark by default on production. `sharedDbLoopAllowed` (`env.ts:30-33`) is deliberately NOT used: it returns true on every non-staging environment regardless of the flag, i.e. it is a staging guard, not a feature toggle (the round-1 F3 acceptance was wrong and is reverted). The second clause hard-blocks staging even if the flag is set by mistake, because staging shares the production database. A Jest test pins: flag absent on production → off; `'true'` on production → on; `'true'` on staging → off.
   - `mapDailyMetricsToFeatures(rows)` (pure). It merges a member-day's `wearable_daily_metrics` rows, and per column the row with the latest `updated_at` wins, with its `provider` recorded. It then maps:
     - `sleep_minutes` → `wearable_sleep_duration` (min)
     - `sleep_efficiency_pct` → `wearable_sleep_efficiency` (%)
     - `hrv_avg_ms` ?? `hrv_rmssd_ms` → `wearable_hrv` (ms)
     - `resting_hr` → `wearable_heart_rate` (bpm)
     - `steps` → `wearable_steps` (steps)
     - `vo2max` → `vo2_max` (ml/kg/min)
     - `max(workout_count, count of wearable_workouts rows that day)` → `wearable_workout` (count, only if > 0)
   - Plausibility bounds drop a value: sleep 1–1440, efficiency 0–100, HRV 1–300, resting HR 25–220, steps 0–100000, VO2 10–95. No value is invented. `wearable_sleep_stages` and `wearable_stress` have no honest source column, so they are not written.
   - `bridgeWearableDays(sb, {tenantId, userId, dates[]})`:
     - (a) Skip users in `fetchExcludedTestServiceAccountIds`.
     - (b) Read that member's `wearable_daily_metrics` and `wearable_workouts` for those dates, across all providers. It reads from the database rather than the event, so the write is idempotent and correct across providers.
     - (c) Write each feature with **device-never-overwrites-member precedence**:
       - Insert with `ignoreDuplicates` on `(tenant_id,user_id,date,feature_key)`.
       - Then update only rows whose `metadata->>source = 'wearable_bridge'`.
       - Each row gets `sample_count` = contributing rows, `confidence = 0.9`, and `metadata = {source:'wearable_bridge', provider, metric_date}`.
       - A member's own voice, diary or manual entry for the same key and day is never replaced. A later member entry replaces the bridge row (existing last-write-wins behaviour of those writers).
     - (d) Call `health_compute_vitana_index_for_user(userId, today)` once.
     - (e) Emit one OASIS event per call: `health.wearable_features.bridged` (info), payload = feature keys, dates, providers, counts. **The bridge's own event carries no health values** (round-1 F2); the pre-existing per-event mirror `connector.wearable.*.recorded` (`connector-webhooks.ts` L202-209) still carries the full vendor payload and is out of scope. On error, emit `health.wearable_features.bridge_failed` (error) with an error code, not raw values. Both types go into `types/cicd.ts`.
   - Repository functions live in `wearable-features-bridge-repository.ts` and take `sb` as a parameter.
3. **`connector-webhooks.ts`.**
   - During the existing loop, collect `{userId, tenantId, metric_date}` (and the UTC `started_at` date for workouts) for rows that upserted without error.
   - After the loop (not per event), if the bridge is enabled, call `bridgeWearableDays` once per distinct user in the request, awaited inside a try/catch; each call reads that user's freshly persisted rows (round-1 Q3).
   - A bridge failure never changes the webhook's 200/`processed` response. The raw data is already stored, and the 02:00 recompute plus the next webhook repair the features.
   - Nothing else in the route changes. The existing full-payload OASIS mirror (L202-209) is left as is (see Not in scope).
4. **No change** to `health_compute_features_daily`, `wearable_samples`, `user-health-context.ts` (wearable stays opt-in, VTID-05025), the frontend or the connectors.
5. **Docs.** `docs/validation/<VTID>/plan-sparring.md` with the approval line. `staging-tests.json` (kind `existing`, the Jest suites below, reason: no route change, and the bridge writes the shared database so it is never run on staging). `STATUS.md`: the D6a row, plus D6b recorded as deferred to Phase 2 with the outline below.

## Rollout
1. Merge with the flag absent everywhere. The staging deploy never sets `WEARABLE_FEATURE_BRIDGE_ENABLED`, and the code refuses on `VITANA_ENV=staging` regardless. Change 1 (commerce path) is live on staging and production after Gate 2.
2. Gate 2 ships the code dark to production.
3. **Planner decision (replaces the former owner question Q2; round-1 F1/F6): the flag stays OFF until D10's enforcement work package (WP3) is in production.** Reason: once bridge rows exist in `health_features_daily`, downstream readers process them unconditionally — the Index, and the nightly consolidator (`nightly-consolidator.ts:437-509`, loop 11) which derives `biometric_trends` whose `latest` values (actual heart rate, HRV, sleep numbers) `agent-profile-service.ts:190-209` renders into the LLM system instruction as "Health signals". Index Spotlight is already gated by `index_spotlight_consent`; the AI-context path is not. Turning the flag on is therefore tied to D10: before enabling, the bridge becomes a D10 enforcement point that writes features only for members holding active `wearables` (for that provider) **and** `ai_health_analysis` consent (recorded as a follow-up in D10's enforcement table). Further preconditions: webhook secrets provisioned (STATUS L18) and at least one real connection.
4. Rollback: unset the flag. Bridge rows are identifiable (`metadata.source='wearable_bridge'`). Deleting them is a separate, approved production write, never part of this change.
5. Phase 1 re-routes this bridge into the observation writer (program L122-127), like every other writer.

## Staging verification (read-only)
- STAGING-VERIFY runs the gateway smoke suite plus `staging-tests.json`: the Jest suites below, by reference. No HTTP probe writes anything.
- Read-only checks on the staging gateway:
  - `GET /alive` and build-info report the merge commit.
  - A webhook POST is **not** sent, because it would write to the shared production database.
- Evidence that the bridge cannot run on staging comes from a unit test (`VITANA_ENV=staging` plus flag `'true'` → no writes), not from staging traffic.

## Tests (Jest, fixture-only; no 0T environment exists yet)
1. `vtid-<D6a>-wearable-features-bridge.test.ts`, using the in-memory fake Supabase:
   - Column → key/unit mapping for every key. Nulls and out-of-bounds values are skipped.
   - The multi-provider merge picks the latest `updated_at` per column.
   - The workout count is the max of the two sources.
   - Running twice gives the same rows (idempotency).
   - A pre-existing `diary_extractor`/voice row is not overwritten, and a pre-existing `wearable_bridge` row is updated.
   - Flag absent, `'false'` or `'TRUE'` → zero writes. `VITANA_ENV=staging` plus `'true'` → zero writes.
   - An excluded test/service account → zero writes and zero RPC calls.
   - The Index RPC runs exactly once per call.
   - The OASIS payload contains no numeric health value. On failure, the `bridge_failed` event is emitted and the function still resolves.
2. `routes/vtid-<D6a>-connector-webhooks-bridge.test.ts`: a mocked verified Terra sleep plus activity event.
   - Flag on → `wearable_daily_metrics` upserted, then the bridge is called once per user with the right dates.
   - Flag off → the bridge is not called.
   - The bridge throws → the response is still `{ok:true, processed}`.
   - An event with no tenant (no connection) → the bridge is not called.
3. Extend `vtid-05025-commerce-health-boundary.test.ts`:
   - Add `vitana_index_scores`, `vitana_pillar_agent_outputs` and `wearable-features-bridge` imports to the commerce scan.
   - Add a body-slice scan (same technique as L152-160) of `tool_find_perfect_product` and `tool_find_perfect_practitioner` and their helper in `orb-tools-shared.ts`: no `vitana_index_scores`, no `weakest`.
   - Behavioural test: `tool_find_perfect_product` without a `pillar` argument issues no `vitana_index_scores` query and no `pillar_tags` filter.
4. Regenerate the VTID-04542 snapshot. Run the full gateway Jest, `tsc --noEmit` and lint. Run `npm run test:support`, `test:operator` and `test:roles` as unaffected regressions.

## Not in scope
- **D6b, the poll scheduler (deferred to Phase 2, outline only).**
  - Trigger: an EventBridge job calls an internal route `POST /api/v1/wearables/internal/sync-tick` with `X-Gateway-Internal`. The route answers 409 on staging and is off unless `WEARABLE_SYNC_ENABLED==='true'`. It is a single invocation, not `setInterval` on every instance, because rotating refresh tokens are not idempotent across instances.
  - A per-connection claim is a conditional update on `last_sync_at`.
  - Tokens: `openToken`, then `refreshToken` when `token_expires_at` is under 10 minutes away, then re-seal and store the rotated refresh token in the same update.
  - Write path: `fetchData` → the same persist code as the webhook → the bridge.
  - Limits: a per-provider concurrency of 1, honouring 429/`Retry-After`, and a per-tick cap. Failures go to `last_error` as an error code and OASIS `connector.wearable.sync.*`.
  - It needs its own sparred plan once a provider is enabled and members are connected (Facts 13, 14, 16).
- Repairing or retiring `health_compute_features_daily` / the `wearable_samples` schema split (Phase 1 replaces both). It is reported in Q3.
- The full health payload in the webhook OASIS mirror (`connector-webhooks.ts` L202-209). That belongs to a D5-type follow-up.
- The device-derived anomaly flags that `nightly-consolidator.ts` (L434-505) will compute from bridged rows and that `agent-profile-service.ts` L195-199 puts into AI context. That belongs to Phase 4, the output guard and §2 pattern catalogue.
- Per-category consent (D10), Index dual-compute (Phase 1), the Connected Apps UI (D3), and any frontend or i18n change. No member-visible string is added.

<!-- plan:end -->
