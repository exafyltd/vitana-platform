# VTID-05161 — plan sparring record (Health Hub Phase 1 / B: `health_sources` merge, writer re-routing, Vitana Index dual-compute and cutover)

| | |
|---|---|
| VTID | **VTID-05161** — package B1 (`health_sources`: table, backfill, S6 service, dark dual-write / read switch / reconciler, `user_integrations` browser-write revoke) |
| Sibling VTIDs (same sparred plan) | B2 VTID-05162 (writer re-routing + derived `health_features_daily_v2`), B3 VTID-05163 (Vitana Index dual-compute, report, cutover + rollback) |
| Sibling packages (own records) | A VTID-05158–05160, C VTID-05164–05166 |
| Program | VTID-05020 (Health Hub plan v2) |
| Sparring session | `de91e6dc-0d60-4b1c-a66f-3f913396f5c3` |
| Partner | `plan-sparring-partner` agent (independent, read-only) |
| Change class | standard |
| Rounds | 2 |
| Verdict | **CONVERGED** |
| Plan hash, round 1 | `0a5b04f50502a5fb3ef400f87547e9c4a36d91c6d53570c6de28d37410bbd979` |
| Plan hash, final | `c8d7960d66b813d2d83d955f8a0a2baf84949020476b87b5502b08b2e559f24d` |

Plan hash = sha256 of the UTF-8 text strictly between the begin and end HTML-comment markers in the "Final plan"
section below.

Owner approval: d.stevanovic@exafy.io in the Claude Code session, 2026-10-13 — "Continue and make the decisions yourself" (Gate 1 for Phase 1 A/B/C; planner defaults taken for every open question)

Planner defaults taken at Gate 1 (open questions of the plan): consent per data category × per source; one
`self_logged_health` key (owned by C1); store dual-write waits for the Aurora cutover (B ships dark and is exercised in
0T); the `user_integrations` browser-write revoke ships with B1 (open question 3: yes); the device cutover's Gate 2 is
treated as the D6a go-live.

## Rounds

| Round | Finding | Severity | Answer | Where in the final plan |
|---|---|---|---|---|
| R1 | F1 — the B–C interface (source resolver, phone-store sources, consent keys) was defined differently in the B and C plans | major | ACCEPTED — resolved by the shared section "Shared interfaces (Phase 1 A/B/C)", identical in A, B and C; S6 is B1's | Shared interfaces S6/S7; Change 0; Change 2 |
| R1 | F2 — a textual copy of the Index formula drifts silently; the drift guard must be functional | major | ACCEPTED — functional drift guard on a throwaway Postgres comparing live function and projection over a fixture matrix | Change 10 (drift guard); Tests B3 |
| R1 | F3 — `self_logged_health` ownership and the cutover for self-logged data | major | ACCEPTED — the key is owned by C1; the cutover is two-stage (device first, self-logged later) | Shared interfaces S7; Changes 7, 12, 13 |
| R1 | F4–F8 | minor | ACCEPTED — folded into the plan text | Facts; Changes 1–14; Tests; Rollout |
| R2 | — | — | CONVERGED; every R1 finding closed | — |
| R2 | F9 — the dual-compute step needs a per-stage status from `executePipelineForUser` | minor | ACCEPTED — the pipeline result is enriched with a per-stage status map | Change 11; Tests B3 |
| R2 | F10 | informational | confirmed, no plan change | — |

The partner's verbatim output for both rounds is kept in the sparring session
`de91e6dc-0d60-4b1c-a66f-3f913396f5c3`; this table records each finding's answer as the planner gave it.

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard. One sparred plan, three VTIDs: B1 (`health_sources`), B2 (writer re-routing + derived features), B3 (Index dual-compute + cutover). Merged in that order, placed in the program-wide order of Shared interfaces (A1 → B1 → A2 → A3 → C1 → C2 → B2 → B3 → C3); B2 also waits for package A's store and ingest (A2) and C1's consent keys to be merged.
- **Program:** Health Hub plan v2 (VTID-05020) Phase 1. Builds on VTID-05030 (D1 sealed tokens), VTID-05089 (D6a wearable features bridge, dark), VTID-05092 (D10 WP1 consent service, in review) and D10 WP3 (consent enforcement, queued).
- **Repos / areas:** vitana-platform only: `supabase/migrations` (three additive migrations), `scripts/aws/aurora-*` parity scripts, `scripts/ci/sql-tests/` + `.github/workflows/SQL-INDEX-DUAL-COMPUTE.yml` (throwaway-Postgres test, existing `SQL-ERASE-USER-DATA.yml` pattern), `services/gateway/src/{services/health-sources,services/health-features,services/daily-recompute-service.ts,services/diary-health-extractor.ts,services/orb-tools/health-depth-tools.ts,services/voice-tools/health-log.ts,services/memory/diary.ts,services/orb-tools-shared.ts,services/action-executors.ts,services/wearable-features-bridge.ts,routes/integrations.ts,routes/wearables.ts,routes/connector-webhooks.ts,routes/health.ts,routes/memory.ts,routes/admin-health-dual-compute.ts (new),index.ts (mount),types/cicd.ts}`. No vitana-v1 change.
- **Regulatory impact:** moves Art. 9 data processing onto the consent-gated store. In the new path nothing is stored or derived without the member's per-category consent (checked in package A's ingest). The Index computation itself is unchanged; the only member-visible effect of the cutover is that data a member has not consented to stops counting toward their Index (Open question 1).
- **Database constraint:** staging shares the production database, so every flag is hard-off on staging. Migrations are applied only after Gate 2. Per program §3.3, Health Hub tables go live in production only on Aurora (or after the §3.3 parity gate). Every gateway change must work when its migration has not been applied, and in that state the legacy path stays exactly as it is today.

## Facts (file:line, origin/main)
**Vitana Index — how health data enters it**
- F1 The function that writes almost every Index row is `health_compute_vitana_index_for_user(uuid, date, text)` (`supabase/migrations/20260424120000_pillar_tags_community_engagement.sql:389`). Inputs: baseline survey (`:475`), calendar completions over 30 days (`:493`), **connected-data sub-score = COUNT of `health_features_daily` rows whose `feature_key` is in the pillar's list, over `CURRENT_DATE - 7 days`, banded 0/15/25/40** (`:524-551`), streak (`:554-563`), pillar weights from `vitana_index_config` (`:571`), balance factor (`:592`), confidence (`:604`), upsert into `vitana_index_scores` with `feature_inputs.subscores` (`:607-640`). `feature_value` is never read: only the presence of a `(date, feature_key)` row counts.
- F2 The streak helper `vitana_pillar_streak_days(uuid, text)` (`20260423130000_vitana_index_compute_v3.sql:45-112`) walks back up to 90 days from `CURRENT_DATE`. It exists in production as `vitana_pillar_streak_days(p_user_id, p_pillar_key)` (read-only catalogue check, 2026-10-13). A day counts if a tagged calendar completion **or any pillar feature row in `health_features_daily`** exists (`:93-101`). So feature rows drive two sub-scores (data over 7 days, streak over up to 90 days).
- F3 Two more compute overloads read the same table. `health_compute_vitana_index(date, text)` (`20260423130000:121`, data at `:276-306`) was never dropped; the drop exists only as a commented rollback note (`20260422150000:239`). It is called by `POST /api/v1/health/recompute/daily` (`routes/health.ts:360, :431` → `routes/health-repository.ts:37-39`) and **by the browser** (vitana-v1 `src/hooks/useVitanaIndex.ts:119`, self-heal). `health_compute_vitana_index(date)` (`20260424120000:36-296`, granted to `authenticated` `:296`) calls the streak helper with a third `p_date` argument (`:219-223`); the two-argument helper exists in production (F2), but no migration defines a three-argument signature, so this overload's call does not match the helper's signature.
- F4 Callers of `_for_user`. Gateway: `orb-tools/health-depth-tools-repository.ts:60-62`, `voice-tools/health-log-repository.ts:59-61`, `routes/integrations-repository.ts:104-106`, `routes/memory-repository.ts:59` (`routes/memory.ts:1725`, `services/memory/diary.ts:101`), `orb-tools-shared.ts:4257`, `routes/calendar-repository.ts:27-31` (`routes/calendar.ts:837`), `wearable-features-bridge-repository.ts:76-78`. Database: the calendar-completion trigger (`20260423150000_vitana_index_contribution_vector.sql:138-171`), `scheduler_vitana_index_compute_daily` (`20260528120000:24-79`) run by `services/daily-recompute-service.ts:27, :227-233` from `POST /api/v1/scheduler/daily-recompute` (`routes/scheduler.ts:61-81`), EventBridge rule `gateway-daily-recompute` 02:00 UTC (`scripts/aws/setup-eventbridge-cron-migration.sh:185`), and the rescore retry (`20260423170000:26`).
- F5 One writer bypasses the formula: `POST /api/v1/health/baseline-survey` upserts a baseline-only row, `model_version='baseline-survey-v3-5pillar'`, with no `subscores` (`routes/health.ts:663, :779-792` → `health-repository.ts:51-53`).
- F6 `vitana_index_scores` is read in 57 files under `services/gateway/src` (grep), plus vitana-v1 `useVitanaIndex.ts:97, :136`, `useVitanaIndexHistory.ts:30` and `supabase/functions/generate-daily-matches/index.ts:181`. This plan changes neither the table nor any of these readers.

**`health_features_daily` and the other health tables**
- F7 `health_features_daily` is unique on `(tenant_id, user_id, date, feature_key)` (`20251231000000_vtid_01103_health_compute_engine.sql:58-71`). **The Index uses exactly 18 feature keys**, identical in all four copies: `_for_user` (`20260424120000:524-551`), the streak helper (`20260423130000:72-78`), `routes/integrations.ts:42-48` and `services/pillar-agents/base-agent.ts:13-19`. They are:
  - nutrition: `biomarker_glucose`, `biomarker_hba1c`, `meal_log`, `macro_balance`
  - hydration: `water_intake`, `hydration_log`
  - exercise: `wearable_heart_rate`, `wearable_steps`, `wearable_workout`, `vo2_max`
  - sleep: `wearable_sleep_duration`, `wearable_sleep_efficiency`, `wearable_hrv`, `wearable_sleep_stages`
  - mental: `wearable_stress`, `mood_entry`, `meditation_minutes`, `journal_entry`

  Device-sourced keys (those the D6a mapper produces, `wearable-features-bridge.ts:81-90`) are seven: `wearable_sleep_duration`, `wearable_sleep_efficiency`, `wearable_hrv`, `wearable_heart_rate`, `wearable_steps`, `vo2_max`, `wearable_workout`.
- F8 Direct writers of `health_features_daily` (all service-role, all in the gateway):
  - **W-diary** `persistDiaryHealthFeatures` (`services/diary-health-extractor.ts:292-330` → repo `:23-25`). It replaces the day's value (`:282-291`), uses `metadata.source='diary_extractor'`, and always writes `journal_entry` (`:262-272`). Called from `routes/memory.ts:1712`, `services/memory/diary.ts:95` and `orb-tools-shared.ts:4244` (`tool_save_diary_entry`, `:4085`).
  - **W-orb** `upsertHealthFeatureAndRecompute` (`orb-tools/health-depth-tools.ts:149-198`), used by `log_meal` (`:204-243`, a read-modify-write count via `fetchHealthFeatureValue` `:217`), `log_vitals` heart rate (`:271`) and `log_mood` (`:344`). `log_vitals` also inserts weight and blood pressure into `wearable_samples` (`:287-307`). `log_biomarker` inserts `lab_reports` and `biomarker_results` (`:392-395`).
  - **W-voice** `logHealthSignal` (`voice-tools/health-log.ts:103-170` → repo `:27-42`), the `log_water/log_sleep/log_exercise/log_meditation` tools via `orb-tools-shared.ts:3975-3990`.
  - **W-manual** `POST /api/v1/integrations/manual/log` (`routes/integrations.ts:129-200` → repo `:71-85`). It writes no `metadata` (`:164-173`), so its rows carry the column default `{}`. It allows `biomarker_glucose`/`biomarker_hba1c` as manual keys (`:43`) and is used by vitana-v1 `src/components/health/VitanaLogDataDialog.tsx:92`.
  - **W-bridge** D6a `bridgeWearableDays` (`services/wearable-features-bridge.ts:226-328`). It is dark (`:37-39`). Its rules are insert-only plus "update only bridge-owned rows", so a device value never overwrites a member's own value (repo `:45-74`).
  - **W-sql** `health_compute_features_daily(date)` (`01103:163-262`), called by `routes/health.ts:385`.
  - W-diary, W-orb, W-voice and W-manual also upsert a `user_integrations` `manual-entry` row (`health-depth-tools-repository.ts:45-58`, `health-log-repository.ts:44-57`, `integrations-repository.ts:88-101`).
- F9 Schema drift between two migrations with the same timestamp. `20251231000000_vtid_01078` (sorts first) and `…_01103` both `CREATE TABLE IF NOT EXISTS` `wearable_samples` and `biomarker_results` with different columns (`01078:79-92, :100-110`; `01103:17-31, :36-…`). Under the 01078 columns, which the voice tool writes (`health-depth-tools-repository.ts:75-80`: `provider, metric, ts`), **W-sql's reads of `sample_type`, `recorded_at` and `biomarker_type` (`01103:196-213, :236-245`) cannot work**. Likewise, `routes/health.ts:196, :290` call `health_ingest_lab_report`/`health_ingest_wearable_samples` with `{p_provider, …}`, while both functions take `(p_payload jsonb)` (`01078:508, :636`). The live catalogue must be confirmed read-only (Rollout 1).
- F10 Other health writers: the webhook path upserts `wearable_daily_metrics` (`routes/connector-webhooks.ts:186`) and `wearable_workouts` (`:192`) and then runs the bridge (`:235-244`); D10 WP3 E2 will gate this on the `wearables` consent. The action executor `wearable_log_workout` inserts manual workouts (`services/action-executors.ts:88-115` → repo `:22-24`). Partner results go to `lab_reports`/`biomarker_results` after a consent check (`partner-health/ingestion.ts:131-160, :210-250`).
- F11 Readers outside the Index:
  - `health_features_daily`: nightly loop 11 → `biometric_trends` (`nightly-consolidator.ts:437-445`, repo `:101`), pillar agents (`pillar-agents/base-agent.ts:68` → repo `:32-39`), the `log_meal` count (`health-depth-tools.ts:217`).
  - Wearable tables: `gemini-operator-repository.ts:70-81`, `routes/wearables-repository.ts:71-81` (`GET /metrics`, `wearables.ts:355`), `user-health-context.ts:379`, `recommendation-engine/analyzers/wearable-analyzer-repository.ts:29`, `automation-handlers/health-action-initiative-repository.ts:58-65`.
  - Lab tables: `routes/patient-health-results.ts:83-110`, `health-depth-tools-repository.ts:122-131`, `automation-handlers/health-wellness-repository.ts:66-73`.

**Connections**
- F12 `user_connections` (`20260417000000_vtid_02100_connector_framework.sql:45-88`) is shared. Health rows are `category IN ('wearable','aggregator')` (`wearables-repository.ts:22-28, :62-69`). The same table holds AI-assistant, delegation and LLM connections (`ai-assistants/ai-assistants-repository.ts:47-103`, `orb/delegation/credentials-repository.ts:26-46`, `routes/llm-repository.ts:26`, `20261013150000_vtid_05133_ai_connection_grants.sql`). Tokens have been sealed since VTID-05030 (`20261010140000`). Health writers: `wearables.ts` connect `:110/:134`, callback `:171/:229`, disconnect `:263/:276`; webhook auth topics `connector-webhooks.ts:136-158`.
- F13 `user_integrations` (`20260423200000_vitana_integrations_v1.sql:35-62`) has **no `tenant_id`**, and its RLS policy is `FOR ALL` owner (`:58-62`), so a browser session can write it. Confirmed in production read-only on 2026-10-13: policy `user_integrations_owner_all` (ALL) lets `authenticated` write, and the table has no `tenant_id` column. vitana-v1 has no direct access to it (grep). `POST /api/v1/integrations/:id/connect` marks any id "connected" without OAuth (`routes/integrations.ts:97-110`). It is read by `GET /api/v1/integrations` (`:50`).
- F14 The D10 consent service has `hasHealthConsent(sb, identity, category, resourceId?)`, which fails closed (`wt-d10w1 services/gateway/src/services/consent/health-consent.ts:139-183`). Its categories are `wearables` (per connector), `partner_results` (per partner), `ai_health_analysis`, `health_data_analytics` and `community_insights` (`:43-68`). **No category covers self-logged data** (diary, voice, manual).
- F15 Patterns to reuse: D6a's dark flag (`=== 'true'` and `VITANA_ENV !== 'staging'`, `wearable-features-bridge.ts:37-39`; `sharedDbLoopAllowed` in `env.ts:30-33` is a staging override, not a toggle). `erase_user_data()` keeps no table list. It discovers its tables from the catalogue at call time: every ordinary or partitioned table in schema `public` with a `uuid` column named `user_id`, except partitions (reached through the parent), `erasure_registry` itself, tables whose `user_id` FK cascades from `auth.users`, and tables registered `retain` in `erasure_registry` (`20261001120000_vtid_04765_erase_user_data.sql:12-18, :94-118`). It has a `p_dry_run` mode and a throwaway-Postgres CI test (`.github/workflows/SQL-ERASE-USER-DATA.yml`, `scripts/ci/sql-tests/run-erase-user-data-test.sh`). The commerce boundary test lists health tables in `HEALTH_TABLES` (`test/vtid-05025-commerce-health-boundary.test.ts:248`).
- F16 The daily recompute is cursor-batched. `processDailyRecomputeBatch` (`services/daily-recompute-service.ts:472`) loads a user batch (`:497`) and runs `executePipelineForUser` for each user (`:547-553`). That runs the stages `index, longevity, topics, community_recs, matches` in order (`:27, :308`), and the batch then returns `next_cursor` (`:576-581`). The scheduler route calls it once per batch (`routes/scheduler.ts:81`).

## Shared interfaces (Phase 1 A/B/C)

This section is the same, word for word, in the A, B and C plans. Where any other text in a plan differs from it, this section wins. Interface ids S1–S10 are the only cross-package contracts. Each plan keeps only its package-specific details and refers here.

| # | Interface | Owner (package) | Consumers |
|---|---|---|---|
| S1 | External wire contract `health-sync/v1`: zod in `services/gateway/src/services/health-sync/contract-v1.ts`, which is the only source; generated `contract-v1.schema.json`; prose in `docs/programs/health-hub/HEALTH-SYNC-CONTRACT-v1.md` | C1 | native Health Sync module, Phase 2 aggregator adapter |
| S2 | Code catalogue: `services/gateway/src/services/health-store/catalogue.ts` plus the `health_codes` seed (A1), with a test that keeps them equal. Exports `HEALTH_CODES`, `categoryOf(code)`, `kindOf(code)`, `dailyRuleOf(code)`, `sourceRankOf(kind)` | A2 (seed A1) | C1 (wire `type` = catalogue key; C adds the HealthKit/Health Connect mapping for the four sync categories only), B2 (writer → code map) |
| S3 | Write: `writeHealthSamples(...)`, the single write entry point (`health-store/ingest.ts`) | A2 | C1 adapter, B2 dual-write, A's own reprocess |
| S4 | Read: `readDailyObservations(...)` plus A's tier readers, all with a mandatory `purpose` (`health-store/reader.ts`) | A2 | B2 derivation, C2 wellness context |
| S5 | `HEALTH_STORE_TABLES` (`health-store/tables.ts`) | A2 | B2 and C2 boundary tests, vtid-05025 |
| S6 | `health_sources` table and `resolveHealthSource`, `setHealthSourceState`, `listHealthSources` (`services/health-sources/health-sources.ts`) | B1 | A2 (source lookup), C1 (phone sources), B1 dual-write |
| S7 | Consent: `findActiveHealthConsentId` (A2) next to `hasHealthConsent`; all new D10 catalogue keys (C1); the consent-key map (A2 `health-store/consent-gate.ts`) | A2 / C1 as named | A2 gate, C1 adapter, C2 |
| S8 | Change hook: `registerHealthStoreChangeHook(fn)` | A2 | B2 registers `rederiveMemberFeatures` |
| S9 | Withdrawal and erasure primitives: SQL `health_store_suppress/unsuppress/purge` with TS wrappers `suppressHealthData`/`unsuppressHealthData`; `POST /api/v1/health/internal/erase-raw` | A1/A2 | Phase 1 consent package, A3 |
| S10 | In-memory Jest fake of S2–S5 and S8: `health-store/testing/fake-health-store.ts` | A2 | B and C tests |

**S1 — wire contract and device pre-aggregation (Health Sync v1).** C owns the only external schema. A publishes no wire schema and no public ingest route. C1 owns `routes/health-ingest.ts`, its mount and path-scoped body parser in `index.ts`, the HTTP rate limiter, `GET /contract` and `GET /status`. C's adapter `processHealthSyncBatch` turns a validated v1 batch into the S3 input; that TypeScript input type is A's internal type, not a second schema. Wire limits are C's (512 KB compressed, 4 MB inflated, ≤ 1,000 records + ≤ 1,000 deletions). Each record's `type` is an S2 key with `kind` `series_sum`, `series_stats` or `record`:
- **Series codes** (`series_sum`, `series_stats`): the app pre-aggregates on the device (HealthKit statistics collection query / Health Connect aggregate by duration) into aligned UTC intervals: 5 minutes when `start` is within the last 30 days, 1 hour when older. There is one item per interval with `record_id = "<type>:<start, ISO-8601 UTC>"`. A `series_sum` item carries `value` (the interval sum). A `series_stats` item carries `stats:{n,sum,min,max}`. When an interval changes, the app re-sends the whole interval (the result is `updated`). An interval whose samples are all gone is sent as a deletion of that `record_id`. No per-sample rows exist anywhere.
- **Record codes** (sleep session with stages, workout, weight, body fat, spot values): one item per OS object, `record_id` = HKObject UUID / Health Connect `metadata.id`.
- **Idempotency:** batch level `(user_id, batch_id)` and record level `(source_id, record_id)`. For series items the record key equals A's bucket key `(source_id, code, bucket_start)`, so the two rules are one rule.

**S3 — `writeHealthSamples`.**
```
writeHealthSamples(sb, {
  identity: { tenant_id, user_id },        // from the JWT or the server-side caller, never from a body
  source_id,                               // health_sources.id (S6)
  batch_id,                                // uuid: the wire batch_id, or a new uuid per server-side call
  via: 'health_sync_native'|'health_sync_aggregator'|'internal'|'reprocess',
  tz?, contract_version?,
  samples:   [{ source_record_id, code, unit, start, end?, tz?, value?, stats?:{n,sum,min,max},
                device?, origin_app_id?, detail? }],
  deletions: [{ source_record_id, code }],
}) → { ok:true, replay:boolean, batch_id,
       results:[{ source_record_id, status, code? }] }
   | { ok:false, code:'STORE_DISABLED'|'STORE_PENDING'|'STORE_UNAVAILABLE'|'SOURCE_NOT_CONNECTED'
                     |'BATCH_ID_REUSED'|'QUOTA_EXCEEDED'|'INVALID_INPUT' }
status ∈ stored | updated | duplicate | deleted | not_found | quarantined | invalid | skipped_no_consent | store_unavailable
```
- **Never throws.** Every failure is a result. A Jest test injects a throwing repository, S3 client and consent read.
- **Order:** store flag (`STORE_DISABLED`, nothing read) → source lookup through S6 (an unknown source or another member's source gives `SOURCE_NOT_CONNECTED`) → batch idempotency → consent per sample (S7) → raw archive of the consented subset → validation and quarantine → store write in chunks of ≤ 2,000 → batch row → change hook if anything was deleted (S8).
- **Consent is inside, per sample category, fail closed.** The consent id is stored on every row and on the batch row. An unconsented sample is `skipped_no_consent` with `code` `CONSENT_REQUIRED`, or `CONSENT_CATEGORY_MISSING` when no D10 key exists. It is never archived, never quarantined, and only counted. Callers may filter first (C does); A still checks.
- **Replace mode is the only mode.** The key is `(source_id, source_record_id)`. Identical content gives `duplicate`; different content replaces the stored row and gives `updated`. There is no `replace` flag. B's replace-semantics writers get this from deterministic keys (`<writer>:<date>:<code>`); event writers use a new uuid per call.
- **Batch replay:** the same `batch_id` with the same normalised-content hash within the 30-day batch retention returns the stored results with `replay:true` and writes nothing. Different content gives `BATCH_ID_REUSED`.
- **Validation codes** (`code` on `quarantined`): `UNKNOWN_CODE`, `CATEGORY_NOT_ALLOWED`, `UNIT_MISMATCH` (unit ≠ catalogue UCUM unit), `IMPLAUSIBLE`, `MISALIGNED_BUCKET`, `TOO_OLD` (`start` older than 400 days or before the earliest partition), `FUTURE` (`end` more than 5 minutes ahead). A quarantine row stores no value. `invalid` (code `INVALID_ITEM`) is a malformed item and is not quarantined.
- **Raw archive** (A's S3 bucket) receives only the consented subset, serialised from this input, never the original request bytes.
- **Limits and quota:** ≤ 5,000 samples + deletions per call. A's per-member DB quota answers `QUOTA_EXCEEDED`.
- **Latency:** p95 ≤ 150 ms for ≤ 10 samples, in process, S3 put included. Jest pins the round trips (one consent read per category present, one S3 put, one RPC per chunk). The 0T load run measures the number, and the result is a condition for activating B2's dual-write.
- `STORE_PENDING` when the store's tables or functions are absent (D10 `isConsentStoreMissing` pattern); nothing is written. `STORE_UNAVAILABLE` covers S3 or database failures.
- **Mapping to Health Sync v1 (C1):** `STORE_DISABLED` → 409 `INGEST_DISABLED` (`reason:'flag_off'`); `STORE_PENDING` → 503 `STORE_PENDING`; `STORE_UNAVAILABLE` and `SOURCE_NOT_CONNECTED` → 503 `STORE_UNAVAILABLE`; `BATCH_ID_REUSED` → 409 `BATCH_ID_REUSED` (not retryable; a new row in C's table); `QUOTA_EXCEEDED` → 429 `RATE_LIMITED`; `INVALID_INPUT` → 400 `INVALID_BATCH`. Per record: `IMPLAUSIBLE` → `IMPLAUSIBLE_VALUE`; `UNIT_MISMATCH` → `UNIT_MISMATCH`; `UNKNOWN_CODE`/`CATEGORY_NOT_ALLOWED` → `UNSUPPORTED_TYPE`; `TOO_OLD`/`FUTURE` → `OUT_OF_WINDOW`; `MISALIGNED_BUCKET`/`INVALID_ITEM` → `INVALID_RECORD`; `skipped_no_consent` → `CATEGORY_NOT_CONSENTED`; `store_unavailable` (a chunk that still failed after one partition-ensure retry; alarm `health.store.partition_missing`) → `STORE_UNAVAILABLE`, retryable; `stored`/`updated`/`duplicate`/`deleted`/`not_found` go into the counts. B2 logs and counts every `ok:false` and non-stored status. These are non-fatal in dual-write mode and fatal only in `derived` mode.
- **Flags:** the ingest route needs C's `HEALTH_SYNC_INGEST_ENABLED` **and** A's `HEALTH_STORE_ENABLED` (+ `HEALTH_RAW_BUCKET`). Both are forced off when `VITANA_ENV=staging`.

**S4 — reads.**
```
readDailyObservations(sb, identity, { codes, from, to, purpose })
  → { ok:true, rows:[{ date, code, value, unit, sample_count, updated_at,
                       sources:[{ source_id, source_kind, value, sample_count }] }] }
  | { ok:false, code:'consent_required'|'PURPOSE_REQUIRED'|'STORE_DISABLED'|'STORE_PENDING'|'STORE_UNAVAILABLE' }
```
- `purpose ∈ 'member_view'|'feature_compute'|'ai_context'` is mandatory and has no default. A missing purpose gives `PURPOSE_REQUIRED`, and the repository is not called.
- **A's I5 rule:** `ai_context` requires `ai_health_analysis` through `hasHealthConsent`, fail closed (`consent_required`, repository not called). `member_view` and `feature_compute` need no extra check, because ingest consent already gated the data.
- Suppressed rows are never returned. `date` is the member's local date. `value` is the code's daily rule (`dailyRuleOf`) from the best-ranked source. `sources` gives each contributor's own value, so B can apply its own precedence.
- `readSeries5m`, `readHourly` and `readRecords` follow the same purpose rule. C's former `readDailyAggregates` is this function. C2 calls it with `purpose:'ai_context'` and B2 with `feature_compute`. Commerce modules may not import `services/health-store/*`.

**S5 — tables.** `HEALTH_STORE_TABLES = ['health_series_5m','health_series_1h','health_series_1d','health_observations','health_ingest_batches','health_ingest_quarantine']`. Only `services/health-store/**` may reference them; this includes erasure and export code. Every other module, the wellness context included, goes through S3/S4. The vtid-05025 commerce boundary test adds them to `HEALTH_TABLES`. B's and C's boundary tests import the constant.

**S6 — sources.** B1 owns the `health_sources` DDL (B Change 1), the service and the names below. A1's store tables keep `source_id uuid` with no FK; B may add one later. No source-resolver stub ships, because B1 merges before A2 and C1.
- `resolveHealthSource(sb, identity, { source_id } | { kind, connector_id?, provider_user_id?, create?:boolean })` → `{ ok:true, source_id, kind, connector_id, status } | { ok:false, code:'STORE_PENDING'|'SOURCE_NOT_CONNECTED'|'STORE_UNAVAILABLE' }`.
  - `create:true` is idempotent and creates the source on first use (manual/voice/diary lazily, phone stores on first sync). It replaces B's `ensureHealthSource`.
  - A lookup by `source_id` must belong to `identity`.
  - Phone stores are `kind:'phone_store'`, `connector_id:'apple_health'|'health_connect'`, `provider_user_id:<install_id>`.
- `setHealthSourceState(sb, identity, { source_id, status:'connected'|'paused'|'disconnected'|'error', reason_code? })` → `{ok:true} | {ok:false, code}`. It replaces B's `recordConnectionState`. C's `os_permission_revoked` → `paused` with `reason_code:'OS_PERMISSION_REVOKED'`; `active` → `connected`.
- `listHealthSources(sb, identity)` is B-only.
- None of these throws. Each answers `STORE_PENDING` while the table is absent (B's former `SOURCES_STORE_PENDING`).
- `source_rank` is not a column. A derives it from `kind` (`sourceRankOf`, S2).

**S7 — consent.**
- `findActiveHealthConsentId(sb, identity, category, resourceId?) → Promise<string|null>` is added by A2, additively, next to `hasHealthConsent` in `services/consent/health-consent.ts`. It uses the same query, returns the row id or null, and returns null on any error (fail closed). C1 uses it and does not add a second one.
- **All new D10 catalogue keys are owned by C1 and ship in C1's single migration:**
  - `sync_activity`, `sync_sleep`, `sync_heart`, `sync_body`: `resource_type='health_source'`, `scope='ingestion:<category>'`, `per_resource=true` (resource ∈ `apple_health`, `health_connect` or an aggregator connector id), `processing_active=true`. Enforcement points are `routes/health-ingest.ts` and `services/health-store/consent-gate.ts`.
  - `self_logged_health` (diary, voice and manual sources, every data category): `resource_type='health_category'`, `scope='ingestion:self_logged'`, `per_resource=false`, `processing_active=true`. The enforcement point is `services/health-store/consent-gate.ts`.
  - The same migration adds the `granted_via` value `native_health_sync`. C3 adds the member copy for all five keys.
- **Consent-key map** (A2 `consent-gate.ts`), keyed by (source kind, data category):
  - `phone_store`/`aggregator` → `sync_<category>` for `activity|sleep|heart|body` (resource = `connector_id`); any other category → no key.
  - `device_cloud` → `wearables` (resource = `connector_id`, D10 today).
  - `partner` → `partner_results` (resource = partner id).
  - `diary`/`voice`/`manual` → `self_logged_health`.
- A2 ships the entries for keys that are not yet in D10's union as `null`. C1 fills them in the same PR that adds the keys. That one-map edit in A's module is C1's only cross-package edit.
- **No key, no write:** A refuses every sample whose (source kind, category) has no key (`skipped_no_consent`, `CONSENT_CATEGORY_MISSING`). B keeps the self-logged writers (diary, voice, manual) on their current tables, with no store dual-write activation for them, until `self_logged_health` is live in production.
- Per-data-category consent beyond these keys, and the wiring of revoke → suppress, stay with the Phase 1 consent package.

**S8/S9 — deletion, withdrawal and the change hook.**
- Every deletion is processed whatever the current consent state; a consent check never blocks a deletion. This covers wire `deletions`, S3 `deletions`, suppress/purge, `erase-raw` and account erasure.
- A2 exports `registerHealthStoreChangeHook(fn: (identity, { dates?, categories?, source_id? }) => Promise<void>)`. A calls the registered hooks after the commit of its withdrawal primitives `suppressHealthData` and `unsuppressHealthData` (S9), and after any `writeHealthSamples` call that deleted rows (with the affected dates).
- Hooks run after the commit, fire-and-forget. A hook error is logged with a code and never fails the primitive.
- B2 registers `rederiveMemberFeatures` at startup. B therefore does not depend on A calling into B's module, and A2 can merge before B2.
- Account erasure needs no hook: `erase_user_data()` removes B's tables in the same pass.

**Connector ids.** C1 registers `apple_health` and `health_connect`: in the connector registry code, as resources accepted for `sync_*` keys (`HEALTH_SYNC_SOURCE_KINDS`), and as `connector_registry` rows in its migration, so B's `health_sources.connector_id` FK holds.

**Production facts (read-only, taken by the planner 2026-10-13).**
- `user_integrations` is writable by `authenticated` through policy `user_integrations_owner_all` (`FOR ALL`) and has no `tenant_id` column (B Change 1b/1c rely on this).
- `vitana_pillar_streak_days(p_user_id, p_pillar_key)` exists in production. Any statement that the two-argument helper is undefined is wrong.

**Merge order (all nine VTIDs, one list):** A1 → B1 → A2 → A3 → C1 → C2 → B2 → B3 → C3.
- A1 deploys nothing.
- B1 provides S6 to A2 and C1.
- A2 provides S2–S5, S7's lookup and S8–S10.
- A3 needs A2's `erase-raw`.
- C1 needs A2 and B1 and adds the S7 keys.
- C2 needs S4 and the `sync_*` keys.
- B2 needs S3/S4/S8/S10 and the `self_logged_health` key.
- B3 needs B2.
- C3 needs the C1 keys and stays draft until counsel's wording exists.

Every merge still goes through its own staging verification and Gate 2. Activation of any flag in production is a separate Gate 2 for each plan.

**Reconciliation decisions**
1. **Single write entry point: `writeHealthSamples`** (S3). A's `ingestHealthBatch` is dropped. B and C already used this name, so fewer callers change. It meets all of B's requirements: it never throws, returns a status per sample, has replace semantics as its only mode (deterministic keys, so no flag), checks consent inside it, fails closed, and has a p95 ≤ 150 ms target for ≤ 10 samples, measured in 0T. C's quarantine list input is dropped: A quarantines through its own validation.
2. **Reads: `readDailyObservations` plus A's tier readers, `purpose` mandatory** (S4). A's I5 rule wins: `ai_context` needs `ai_health_analysis`, fail closed. C's `readDailyAggregates` is renamed to it. The row shape is the superset of B's and C's needs.
3. **Wire format: C owns the only external schema** (S1, `health-sync/contract-v1.ts`). A's `IngestBatchV1`, its generated JSON Schema and A's public `POST /api/v1/health/ingest` route are removed. C's adapter output (the S3 input) is A's input, and that input is an internal TypeScript type, not a second schema. The code catalogue stays A's (S2), because the store seeds `health_codes` and B needs the non-wire codes. C imports it and adds only the HealthKit/Health Connect mapping.
4. **`health_sources` is owned by B1** (closes B open question 4). The resolver and state functions are B's: `resolveHealthSource`, `setHealthSourceState`, `listHealthSources`. A's `HealthSourceResolver.resolve` and null stub, B's `ensureHealthSource`/`recordConnectionState` and `SOURCES_STORE_PENDING`, and A's resolver-supplied `source_rank` are replaced. There is no stub, because B1 merges before A2 and C1.
5. **Idempotency is one rule:** batch `(user_id, batch_id)` and record `(source_id, record_id)`. C's contract states the device pre-aggregation into aligned 5-minute/1-hour intervals, with `record_id = "<type>:<start>"`, so A's bucket replace and C's record key coincide (S1). This closes A open question 9. A's batch unique key becomes `(user_id, batch_id)` (the partition key is added internally). C gains the wire code `BATCH_ID_REUSED`.
6. **Consent:**
   - `findActiveHealthConsentId` is added once, by A2, next to `hasHealthConsent`.
   - All new D10 keys belong to C1 in one migration: `sync_activity`, `sync_sleep`, `sync_heart`, `sync_body` and `self_logged_health`.
   - A refuses every write whose source kind and category have no key.
   - B keeps the self-logged writers on their current tables until `self_logged_health` is live.
   - This closes A open question 1 and B open question 1 with the simplest option, one self-logged key. A finer per-category split later is additive, and stays an owner question.
   - Phone stores use `sync_*`, not A's `wearables`; device clouds keep `wearables`.
7. **Deletion and withdrawal:** deletions are processed whatever the current consent. B's `rederiveMemberFeatures` is triggered by A's withdrawal primitives (and by committed deletions) through the S8 hook registry that B2 registers into. A never imports B.
8. **Connector ids `apple_health` and `health_connect` are registered by C1** (closes A open question 7). This covers the code registry, the D10 grant-route resource list and the `connector_registry` rows.
9. **Merge order:** A1 → B1 → A2 → A3 → C1 → C2 → B2 → B3 → C3. C2 is no longer parallel to C1, because it needs the `sync_*` keys.
10. **Route and status ownership:** C1 owns `routes/health-ingest.ts`, its body parser, rate limiter and `GET /status`. A keeps only `routes/health-store-internal.ts` (maintenance, reprocess, erase-raw, and a JWT-authenticated `GET /api/v1/health/internal/store-status` → `{enabled, reason}`). C's `/status` embeds A's state as `store:{enabled, reason}`. A's DB quota stays inside S3.
11. **Glucose/HbA1c:** the catalogue has no glucose/CGM/HbA1c code (owner decision 7). B's manual `biomarker_glucose`/`biomarker_hba1c` keys therefore stay on the legacy path, and the diff classifies them as `writer_not_rerouted`.
12. **Time window:** `TOO_OLD` > 400 days and `FUTURE` > 5 minutes, one rule for wire and store. C's values are taken because they are the stricter ones.
13. **Production facts folded in:** `user_integrations` is writable by `authenticated` (`user_integrations_owner_all`, ALL) and has no `tenant_id`; `vitana_pillar_streak_days(p_user_id, p_pillar_key)` exists in production. B's text was corrected where it implied otherwise.

## Changes (numbered)
**0. Interfaces with A and C.** B builds against **Shared interfaces (Phase 1 A/B/C)** above, and adapts to it where its earlier names differed:
   - B uses S3 `writeHealthSamples` (never throws, per-sample status, replace by deterministic key, consent inside, p95 ≤ 150 ms for ≤ 10 samples), S2 codes and `categoryOf`, S4 `readDailyObservations` with `purpose:'feature_compute'`, S5 `HEALTH_STORE_TABLES` and the S10 fake.
   - B registers `rederiveMemberFeatures(identity, { dates?, categories?, source_id? })` through S8 `registerHealthStoreChangeHook`. A fires it after withdrawal primitives and committed deletions (S9). This is how program §3.6 "derived features/Index recomputed" happens.
   - B owns `health_sources` and S6 (`resolveHealthSource`, `setHealthSourceState`, `listHealthSources`). A's `source_id` is `health_sources.id`.
   - The self-logged consent key `self_logged_health` comes from C1 (S7). Until it is live in production, B does not activate store dual-write for diary, voice and manual writers; they stay on their current tables.
   - The catalogue has no glucose/HbA1c code (owner decision 7), so W-manual's `biomarker_glucose`/`biomarker_hba1c` stay legacy-only and are classified `writer_not_rerouted`.

**B1 — `health_sources` (one connection model)**
1. **Additive migration** `…_vtid_<B1>_health_sources.sql`:
   a. `health_sources` columns:
      - `id uuid pk`, `tenant_id uuid not null`, `user_id uuid not null`
      - `kind text not null check in (device_cloud, aggregator, phone_store, partner, manual, voice, diary)`
      - `connector_id text null references connector_registry(id)`, `provider_user_id text`
      - `status text not null check in (pending, connected, paused, disconnected, error)`
      - `token_ref text null`: a pointer `user_connections:<uuid>`, never a token. Tokens stay sealed in `user_connections` (VTID-05030); the KMS move stays the recorded deferred item.
      - `sync_cursor jsonb`, `last_sync_at`, `last_error_code text`, `connected_at`, `disconnected_at`
      - `legacy_user_connection_id uuid unique null`, `legacy_user_integration_id uuid unique null`
      - `created_at`, `updated_at`
      - Unique `(tenant_id, user_id, kind, coalesce(connector_id,''), coalesce(provider_user_id,''))`.

      RLS SELECT `user_id = auth.uid()`. No INSERT/UPDATE/DELETE for `anon`/`authenticated`.
   b. **Backfill** (idempotent, `ON CONFLICT DO NOTHING`):
      - every `user_connections` row with `category IN ('wearable','aggregator')`;
      - every `user_integrations` row, with tenant from `user_tenants`. Rows without a tenant are skipped and counted in a `RAISE NOTICE`.
   c. `user_integrations`: revoke INSERT/UPDATE/DELETE from `anon`/`authenticated`, and replace the `FOR ALL` policy with a SELECT-only owner policy (F13). The gateway uses service role, so no caller breaks.
   d. The same objects go into `scripts/aws/aurora-restore-rls-parity.sql` and `aurora-cutover-restore-grants.sql`.
2. **Service** `services/gateway/src/services/health-sources/health-sources.ts` (S6):
   - `resolveHealthSource(sb, identity, { source_id } | { kind, connector_id?, provider_user_id?, create?:boolean })` → `{ ok:true, source_id, kind, connector_id, status } | { ok:false, code:'STORE_PENDING'|'SOURCE_NOT_CONNECTED'|'STORE_UNAVAILABLE' }`. This is the S6 signature unchanged. With `create:true` it is idempotent and creates `manual|voice|diary` sources lazily and phone-store sources on first sync.
     - **Phone stores (C1's caller):** C passes `{ kind:'phone_store', install_id, platform }`. The input type also accepts this shape as an alias. Before any lookup it is normalised to the canonical S6 phone-store form `{ kind:'phone_store', connector_id: platform==='ios' ? 'apple_health' : 'health_connect', provider_user_id: install_id }`.
     - An unknown `platform` or an empty `install_id` gives `SOURCE_NOT_CONNECTED`, and nothing is created.
     - Both shapes resolve to the same row, and a test pins that. The alias adds no field or result code to S6.
     - The `connector_id` FK holds only once C1 has registered `apple_health`/`health_connect` (Shared interfaces, "Connector ids"). Before that, a phone-store `create` fails on the FK and answers `STORE_UNAVAILABLE`.
     - Connector-based sources (`device_cloud`, `aggregator`, `partner`) use `connector_id` (+ `provider_user_id`), as in S6.
   - `setHealthSourceState(sb, identity, {source_id, status:'connected'|'paused'|'disconnected'|'error', reason_code?})` → `{ok:true} | {ok:false, code}`. C's `os_permission_revoked` → `paused` with `reason_code:'OS_PERMISSION_REVOKED'`.
   - `listHealthSources(sb, identity)`.

   A missing table gives `{ok:false, code:'STORE_PENDING'}`, never an exception into the caller.
3. **Dual-write** behind `HEALTH_SOURCES_DUAL_WRITE` (`=== 'true'` and not staging). After each legacy write in F12/F13 (wearables connect/callback/disconnect, webhook auth topics, integrations connect/disconnect, the four `manual-entry` upserts), the matching `health_sources` write runs. A failure is logged with a code and counted, and emits OASIS `health.sources.dual_write_failed` (codes only). It never changes the legacy response.
4. **Read switch** behind `HEALTH_SOURCES_READ`: `GET /api/v1/integrations`, `GET /api/v1/wearables/connections` and the connected flags in `GET /providers` read `health_sources`. Response shapes stay byte-identical (contract test). Writes keep going to both models until a later decommission plan.
5. **Reconciler (read-only):** a nightly count of the two models per kind and status. It emits OASIS `health.sources.reconcile` with counts only. A non-zero mismatch blocks the B1 read-switch Gate 2.

**B2 — re-route every writer; derive `health_features_daily_v2`**
6. **Mapping as data** in `services/health-features/feature-spec.ts` (frozen object plus test):
   - For each of the 18 Index `feature_key`s (enumerated in F7): the S2 code(s) or `null`, the aggregation (count / sum / latest), the plausibility bounds (D6a `COLUMN_FEATURES` reused), the pillar, and `origin` (`device` for the seven device keys of F7, otherwise `self_logged`).
   - `null` (never derived) applies to `biomarker_glucose`, `biomarker_hba1c` (Reconciliation 11), and to `macro_balance`, `wearable_sleep_stages` and `wearable_stress` unless S2 gains a code.
   - For each writer: `kind`, and its `source_record_id` rule.
     - Replace-semantics writers use a deterministic key `<writer>:<date>:<code>` (S3 replaces by key; there is no `replace` flag): diary, W-voice, W-manual, `log_mood`, `log_vitals` heart rate, webhook daily metrics.
     - Event writers use a uuid per call: `log_meal`, manual workout.
     - Webhook workouts use `<connector>:<external_workout_id>`.
   - A test asserts that the key lists in F7 (SQL, `integrations.ts`, `base-agent.ts`) equal the spec.
7. **Dual-write**, behind two flags so device and self-logged start separately:
   - `HEALTH_STORE_DUAL_WRITE_DEVICE` covers the webhook writer and `wearable_log_workout`. Its activation date is D0.
   - `HEALTH_STORE_DUAL_WRITE_SELF_LOGGED` covers diary, voice, ORB and manual. It is activated only once `self_logged_health` is live in production (S7). Its activation date is D0s.

   Both flags must be exactly `'true'` and are blocked on staging. Each writer, after its legacy write succeeded, calls `recordToHealthStore(sb, identity, writerId, values)`, which runs `resolveHealthSource(…, {create:true})` and then `writeHealthSamples` (S3). The writers are:
   - W-diary at its three call sites
   - W-orb (`log_meal`, `log_mood`, `log_vitals` incl. weight/BP)
   - W-voice
   - W-manual
   - the webhook daily-metrics/workout persist (`connector-webhooks.ts:186, :192`, after the per-event persist and only when the legacy write succeeded)
   - `wearable_log_workout`

   **Consent:** the gate is A's ingest; B never writes observations directly. A CI test forbids any reference to a `HEALTH_STORE_TABLES` table (S5) outside package A's module, and asserts that every writer in this list routes through `recordToHealthStore`. Unconsented samples are counted `skipped_no_consent`. **The legacy path is not newly gated in B** (device ingest is gated by D10 WP3 E2). Gating self-logged legacy writes would change live member behaviour before the cutover decision (Open question 1).

   In this mode a store failure is non-fatal, and the legacy response is unchanged.
   **Not re-routed in B:**
   - W-sql and the two legacy ingest RPC routes (F9): broken or unused, verified in Rollout 1. In derived mode `/recompute/daily` step 1 calls the derivation instead (Change 13).
   - `log_biomarker` and partner lab results: no Index feature comes from them, and lab modelling (codes, reference ranges) is Phase 5's FHIR adapter.
8. **Derivation** `services/health-features/derive-daily-features.ts`:
   - Pure `deriveFeatures(dailyObservations) → FeatureRow[]` per the spec.
   - Precedence for value keys: member-stated over device (the D6a rule); counts sum across sources.
   - It never produces `wearable_sleep_stages`, `wearable_stress` or `macro_balance` unless a code exists for them. This matches today's writers.

   `deriveAndStore(sb, identity, dates, target)` reads S4 (`purpose:'feature_compute'`) and upserts `target='v2'` → `health_features_daily_v2`, with `metadata.source='derived_v2'` and `derivation_version`. It runs:
   - after each successful dual-write, after the response is sent;
   - nightly for the previous 2 days;
   - from A's change hook (S8) as `rederiveMemberFeatures`, registered by B2 at startup, which also deletes v2 rows the store no longer supports.

   **Eventual consistency and the pending marker:**
   - In `legacy` mode the derived table lags the store by the time between the store write and the post-response derivation, normally under a few seconds. Nothing a member sees reads `health_features_daily_v2`, so the lag has no member effect.
   - `recordToHealthStore` writes a marker row `health_features_derivation_pending (tenant_id, user_id, date, enqueued_at)` (upsert, unique per member-day). It does this after `writeHealthSamples` returns and **before the HTTP or tool response is sent**. A successful derivation deletes the marker.
   - A crash between response and derivation therefore leaves the marker. The nightly run derives every member-day with a marker older than 5 minutes, before its "previous 2 days" pass. Its OASIS count `health.features.derivation_catch_up` reports how many markers it found.
   - The worst-case lag is one nightly cycle (≤ 24 h).
   - The dual-compute (Change 11) classifies a member-day that still has a marker as `derivation_pending`, not as a gap. It is re-checked the next day.
   - A marker write failure is counted. It does not change the legacy response, because the nightly "previous 2 days" pass still covers that day.
   - In `derived` modes the derivation runs synchronously inside the request (Change 13), so the lag is zero for the member-visible table. The marker is still written first, so a crash mid-request is caught the same way.
9. **Additive migration** `…_vtid_<B2>_health_features_v2.sql`:
   - `health_features_daily_v2`: the same columns and unique key as `health_features_daily`, plus `derivation_version text not null` and `source_kinds text[]`.
   - `health_features_daily_legacy_shadow`: the same columns as `health_features_daily`. It is created empty now and used only after cutover (Change 13).
   - `health_features_derivation_pending`: `tenant_id`, `user_id`, `date`, `enqueued_at`, `attempts int`. Unique `(tenant_id, user_id, date)`.

   All three tables are service-role only (no grant to `authenticated`) and are added to `HEALTH_TABLES` in the commerce boundary test and to the Aurora parity scripts.

   **Erasure:** all three have `user_id uuid not null` in schema `public`, with no FK to `auth.users` and no `erasure_registry` entry. So `erase_user_data()` finds them by its catalogue scan (F15) with no change to that function. The same holds for `health_sources` (B1) and `vitana_index_dual_compute` (B3). Because the function keeps no list, nothing is added to it. The SQL test (Tests, B2/B3) asserts the scan finds all five and that a dry run counts their rows.

**B3 — Index dual-compute, diff, cutover, rollback**
10. **Read-only projection in SQL** (migration `…_vtid_<B3>_index_dual_compute.sql`):
    - `vitana_index_project_for_user(p_user_id uuid, p_device_from date, p_self_from date) RETURNS jsonb STABLE SECURITY DEFINER`, EXECUTE to `service_role` only. It is a copy of F1's arithmetic with one difference: the feature rows it counts come from one set, built from both tables in the same statement, per key class (F7, Change 6 `origin`):
      - **Device keys** (the seven of F7): `health_features_daily_v2` rows for `date >= p_device_from`. Before that date, and when `p_device_from` is NULL, legacy rows.
      - **Self-logged keys with an S2 code:** `health_features_daily_v2` rows for `date >= p_self_from`. Before that date, and when `p_self_from` is NULL, legacy rows. (The D6a bridge writes only device keys, so no source filter is needed here.)
      - **Keys with no code** (`biomarker_*`, and `macro_balance`, `wearable_sleep_stages`, `wearable_stress` unless coded): always legacy.
      - The three calls used are: legacy `(NULL, NULL)`; Stage 1 device scope `(D0, NULL)`; Stage 2 full scope `(D0, D0s)`.
    - The streak uses `vitana_pillar_streak_days_projected(p_user_id, p_pillar, p_device_from, p_self_from)` (F2 over the same row set).
    - Both functions are `STABLE`, so they cannot write. The live functions are not touched.
    - **Why a copy and not a parameter on the live function.** Two reasons:
      - The live function is the hot Index writer (F4), called by the calendar trigger and the scheduler. Changing its body or signature would put the live Index at risk for a measurement tool.
      - Every one of F1's five data-count queries and F2's per-day `EXISTS` must read the union of two tables in one pass for the same member and window. That cannot be done by calling the live function twice.
    - **Drift guard (functional, not textual).** The script `scripts/ci/sql-tests/run-index-dual-compute-test.sh`, run by the workflow `SQL-INDEX-DUAL-COMPUTE.yml` on a throwaway `postgres:16` (same pattern as `SQL-ERASE-USER-DATA.yml`; it is triggered by changes to any Index or projection migration), does this:
      1. It applies the Index migrations and the projection to an empty database.
      2. For every fixture, it loads **the identical feature rows into both `health_features_daily` and `health_features_daily_v2`**, plus the same baseline survey, calendar completions and `vitana_index_config` weights.
      3. It runs the live `_for_user` and the projection with `(p_device_from, p_self_from)` ∈ {(NULL,NULL), (D0,NULL), (D0,D0s), (D0s,D0)} for D0/D0s before, inside and after the fixture window.
      4. It asserts that totals, per-pillar scores, every sub-score (baseline/completions/data/streak) and the confidence are equal.

      The fixture matrix:
      - each of the five pillars alone and all together;
      - data-count band edges (0, 1, 3, 4, 10, 11 rows in 7 days);
      - streak edges: 0, 6, 7, 13, 14, 29, 30, 89 and 90 consecutive days, a one-day gap, and a streak carried only by calendar completions or only by features;
      - empty days inside the window;
      - rows exactly 7 days old;
      - no baseline survey;
      - non-default weights;
      - every balance-factor band.

      `CURRENT_DATE` is pinned through fixture dates relative to `CURRENT_DATE`. Any change to the live formula breaks equality and fails CI until the copy follows. A Jest wrapper asserts that the workflow's path triggers include every migration that defines `health_compute_vitana_index_for_user` or `vitana_pillar_streak_days`.
    - The start dates are the dual-write activation dates: D0 for device keys and D0s for self-logged keys (Change 7). That is the state the cutover produces (legacy history, derived from the start date on), so no history backfill is needed for streak parity.

    `vitana_index_dual_compute` table:
    - columns: `tenant_id`, `user_id`, `date`, `scope`, `live_total`, `legacy_total` (projection with NULL), `v2_total` (projection with the scope's start dates), per-pillar `data` and `streak` sub-scores for both, `device_rows_missing int`, `device_rows_extra int`, `self_rows_missing int`, `self_rows_extra int`, `diff_class text[]`, `formula_ok boolean`, `computed_at`;
    - unique `(tenant_id, user_id, date, scope)`;
    - service-role only, purged after 120 days by the same step.
11. **Dual-compute as the final step of the existing daily recompute** (no new route, no new EventBridge rule). In `processDailyRecomputeBatch` (F16), after the batch's user loop has finished every stage, a final step `runIndexDualComputeForBatch(users)` runs. It covers only the batch's users whose `index` stage ended `success` for that run date, so the live row it compares against was written moments earlier in the same job.
    - It is gated by `VITANA_INDEX_DUAL_COMPUTE_ENABLED` (`=== 'true'` and a **hard staging block**).
    - Its errors are counted in a separate `dual_compute:{compared, failed}` field of the batch result. They never change `ok`, `processed`, `failed` or `next_cursor`, and never mark a pipeline stage failed.
    - Its time is capped per batch (`DUAL_COMPUTE_BATCH_BUDGET_MS`, default 20 s). Users past the cap are counted `skipped_budget`.
    - Per user:
      1. Call the projection with `scope='device'` `(D0, NULL)` always, and with `scope='all'` `(D0, D0s)` once D0s exists (Change 12).
      2. Read the live row.
      3. Build the device reference set `R_dev`: run D6a's pure `mapDailyMetricsToFeatures` (`wearable-features-bridge.ts:113`) over the member's `wearable_daily_metrics`/`wearable_workouts` for dates ≥ D0. Only providers for which the member holds `wearables` consent (`hasHealthConsent`, F14) are included. This is read-only, and it is what the bridge would have written.
      4. Diff the `(date, feature_key)` row sets over 90 days. Device keys: v2 against `R_dev`. Self-logged keys (only in `scope='all'`): v2 against legacy rows whose `metadata.source` belongs to a re-routed self-logged writer, or whose metadata is `{}` for W-manual (F8).
      5. Classify each difference:
         - `consent_withheld`: the category has no consent (S7 key map);
         - `writer_not_rerouted`: the legacy row comes from a writer outside Change 7, or its key has no S2 code (`biomarker_*`);
         - `derivation_pending`: a pending marker exists (Change 8);
         - `derivation_gap`: an observation exists, no marker exists, and there is no v2 row;
         - `store_write_failed`: a dual-write failure was counted for that member-day;
         - `formula_drift`: `legacy_total ≠ live_total`;
         - `not_comparable`: the live row is the F5 baseline-only row.
    - It writes one row per scope and emits nothing per member.
12. **Report and convergence criteria.** `GET /api/v1/admin/health/index-dual-compute/report?from&to&scope` (new `routes/admin-health-dual-compute.ts`, `exafy_admin`) returns aggregates only: member-days compared, % with Δtotal = 0, p50/p95/max |Δtotal|, member-days per `diff_class`, row-set mismatches per key class, and job failures. No per-member rows and no health values. A daily OASIS `health.index.dual_compute.report` event carries the same counts (declared in `types/cicd.ts`).

    **Why row sets decide.** The Index reads only the presence of `(date, feature_key)` rows (F1 data counts, F2 streak `EXISTS`). The functional drift guard (Change 10) proves the projection computes the live formula exactly. So, for a member, equal row sets over the 90-day window give an equal Index, and the row-set check is the criterion. Δtotal is reported as a cross-check.

    **Stage 1 — device inputs (can be met before `self_logged_health` exists).** D0 is the day `HEALTH_STORE_DUAL_WRITE_DEVICE` was activated. The stage passes when all of these hold:
    - ≥ 14 consecutive days of the step green, after a 7-day warm-up from D0;
    - for members with `wearables` consent, zero member-days with `device_rows_missing` or `device_rows_extra` other than `derivation_pending` that cleared the next day;
    - zero member-days classed `derivation_gap` or `store_write_failed` for device keys;
    - `formula_drift` ≤ 0.5% of member-days, each explained (normally a calendar completion between the `index` stage and the final step).

    Stage 1 is the precondition for the `derived_device` cutover (Change 13).

    **Stage 2 — self-logged inputs (a later criterion).** D0s is the day `self_logged_health` is live in production (C1) and self-logged dual-write is activated. Stage 2 then requires the same four conditions for the self-logged keys over ≥ 14 days after a 7-day warm-up from D0s, plus Δtotal = 0 on every member-day with `scope='all'` for members holding every needed consent. The `consent_withheld` impact (members and points affected) is reported to the owner as a number, not as pass/fail (Open question 1). Stage 2 is the precondition for the full `derived` cutover.
13. **Cutover switch** `HEALTH_FEATURES_SOURCE` = `legacy` (default; any unknown value = legacy) | `derived_device` | `derived`, with `HEALTH_FEATURES_CUTOVER_DATE` = C (per value).

    Both derived modes:
    - The affected writers stop writing those keys to `health_features_daily`. They write the same legacy-shaped row to `health_features_daily_legacy_shadow`, for rollback.
    - `writeHealthSamples` → pending marker → `deriveAndStore(…, target='live')` run synchronously in the request. Derived rows are published into `health_features_daily` for dates ≥ C with `metadata.source='derived_v2'`, and the existing `_for_user` recompute call each writer already makes then runs. The member's Index never lags the write.
    - A store or derivation failure is fatal for that call: an error code goes back to the caller, and spoken replies stay model-composed (NEVER rule 41).

    `derived_device` (after Stage 1): applies only to the webhook writer and `wearable_log_workout` (device keys).
    - The D6a bridge is skipped, and the derivation takes its place. This makes device data count in the Index, so this Gate 2 is also the D6a activation decision.
    - Self-logged writers stay on `legacy`.

    `derived` (after Stage 2): every re-routed writer.
    - W-sql is skipped.
    - `/recompute/daily` step 1 calls the derivation.
    - `biomarker_*` stay legacy (Reconciliation 11).

    Unchanged in both: the Index functions, the trigger, the scheduler stage, the browser RPC (F3) and every reader. The final dual-compute step keeps running for 14 days after each cutover as a regression monitor (shadow and live roles swapped).
14. **Rollback protocol** (used only if a post-cutover check fails):
    a. **Prepared and reviewed in advance.** The cutover PR commits the data-fixup file `supabase/migrations/data-fixups/<ts>_vtid_<B3>_rollback_health_features.sql`, which is reviewed with that PR. The file runs in **one transaction** (`BEGIN … COMMIT`, with `SET LOCAL lock_timeout`). For dates ≥ C and the keys of the mode being rolled back, it does two things:
       - it copies `health_features_daily_legacy_shadow` rows over `health_features_daily` (`ON CONFLICT (tenant_id,user_id,date,feature_key) DO UPDATE`);
       - it deletes `derived_v2` rows that have no shadow counterpart.

       It ends with a `RAISE EXCEPTION` guard that rolls everything back if the post-condition counts below do not match inside the transaction.
    b. **Who runs it.** It is a production write that the gates do not cover. Only the owner runs it, or the owner records an authorization for one named session (recorded in `docs/validation/<VTID>/rollback.md` with the time and reason). It is applied only through the approved migration path, never through ad-hoc SQL.
    c. **Order:** first set `HEALTH_FEATURES_SOURCE` back (a config-only prod deploy pinned to the same commit), so no new derived rows appear. Then apply the fix-up. Then run the existing daily Index stage for the affected members.
    d. **Read-only verification afterwards.** One query proves that, for dates ≥ C and the rolled-back keys, the set of `health_features_daily` rows equals the shadow, and that no `derived_v2` row remains. Its result goes into the rollback record. Production gets nothing beyond this read and the normal post-deploy health/build-info check.
    e. Before any cutover, nothing in `legacy` mode depends on B's tables, so switching a flag off is enough.

## Tests
- **B1 Jest:**
  - `health-sources.test.ts`: idempotent `resolveHealthSource(create:true)`; `STORE_PENDING` without the table; dual-write failure leaves the legacy response unchanged; flag off or staging → no write.
  - Read-switch contract tests: `GET /integrations`, `/wearables/connections` and `/providers` give byte-identical JSON for both flag states over the same fixture.
  - Migration test (pattern `test/migrations/vtid-04765-…`): RLS select-own, no browser writes, the `user_integrations` revoke and SELECT-only policy, backfill filter `category IN ('wearable','aggregator')`, `token_ref` is never a token column, parity scripts updated.
- **B2 Jest:**
  - Spec equality with the three key lists (F7).
  - Each writer calls `recordToHealthStore` only after a successful legacy write, with the documented `source_record_id` rule.
  - A `skipped_no_consent` result, or a call-level `STORE_PENDING`/`STORE_UNAVAILABLE`/`STORE_DISABLED`, changes nothing in the legacy response or in the voice tool's result.
  - The CI grep rule: no `HEALTH_STORE_TABLES` access outside A.
  - `deriveFeatures` golden fixtures: one member-day per writer, multi-source precedence, implausible values dropped, never-produced keys.
  - `rederiveMemberFeatures` deletes v2 rows whose observations were withdrawn.
  - Existing suites stay green: `vtid-05089-wearable-features-bridge`, `health-log`, `health-depth-tools`, `vtid-05025` (with the new tables in `HEALTH_TABLES`), `npm run test:support`, `test:operator`.
- **B3:**
  - **SQL (throwaway `postgres:16`, `SQL-INDEX-DUAL-COMPUTE.yml`):**
    - the functional drift guard and its fixture matrix (Change 10);
    - `(D0, NULL)` takes device keys from v2 and every other key from legacy; `(D0, D0s)` takes self-logged coded keys from v2 from D0s on; keys with no code always come from legacy;
    - both projection functions are `STABLE` (a write inside them raises);
    - the rollback fix-up (Change 14): on a fixture it restores shadow rows, removes orphan `derived_v2` rows, and rolls back entirely when its guard fails;
    - erasure: an `erase_user_data(p_user_id, true)` dry run lists `health_sources`, `health_features_daily_v2`, `health_features_daily_legacy_shadow`, `health_features_derivation_pending` and `vitana_index_dual_compute`, and a real run empties them for that member only.
  - **Jest:**
    - The final step runs only after the batch's stages, only for users whose `index` stage succeeded (`executePipelineForUser`'s result is enriched with a per-stage status map, because today it returns only an overall `ok` — round-2 F9), and never changes `ok`/`processed`/`failed`/`next_cursor` (including when it throws or exceeds its budget). It is a no-op on staging or with the flag unset.
    - `R_dev` built from `mapDailyMetricsToFeatures` only for consented providers.
    - Classification unit tests for every `diff_class`, including `derivation_pending` (a marker present) against `derivation_gap`.
    - Report: aggregates only; no `user_id` or values in the payload. Stage 1 and Stage 2 computed from fixtures.
    - Pending marker: written before the response, deleted after derivation, picked up by the nightly catch-up after a simulated crash.
    - Cutover: in `derived_device` only the device writers stop writing `health_features_daily` and the bridge is skipped; in `derived` all re-routed writers do. Shadow rows are written. Derivation is synchronous, publishes only dates ≥ C, and a failure is loud. W-sql is skipped in `derived`.
    - `resolveHealthSource` phone alias resolves to the same row as the canonical S6 form.
- No test writes to the shared database. All write paths are proven with fakes or local Postgres; vendor and write-path runs belong to 0T.

## Rollout
1. **Before Gate 1 (read-only, no SQL execution against data):** confirm from the production catalogue (`pg_proc`, `information_schema.columns`), as a read-only check:
   - which `health_compute_vitana_index` overloads exist, and which `vitana_pillar_streak_days` signatures exist besides `(p_user_id, p_pillar_key)`, which is already confirmed (F2);
   - the live columns of `wearable_samples` and `biomarker_results` (F9);
   - whether `health_compute_features_daily` and the two ingest RPC routes can succeed;
   - that the EventBridge rule `gateway-daily-recompute` exists and is enabled (`aws events describe-rule`); the dual-compute runs inside that job (Change 11).

   The answers fix Change 7's "not re-routed" list and Change 10's projection source.
2. Spar this plan → Gate 1 → three VTIDs citing the sparring record.
3. **B1** PR → staging (flags unset, migration unapplied, so both endpoints answer from the legacy model) → STAGING-VERIFY → Gate 2. On "yes", the B1 migration is applied **only on Aurora after the cutover, or under the §3.3 parity gate**, then the gateway deploy is pinned. Before Gate 2, run read-only counts (no writes): health rows in `user_connections` by connector, `user_integrations` by id, and rows without a tenant. Then turn on dual-write; after 7 clean reconciler days, turn on the read switch (config deploys, each with its own Gate 2).
4. **B2** after A2 and C1 are merged → same path. Activation needs A's store live in production and D10 WP3.
   - `HEALTH_STORE_DUAL_WRITE_DEVICE` sets D0.
   - `HEALTH_STORE_DUAL_WRITE_SELF_LOGGED` follows only when `self_logged_health` is live in production, and sets D0s.
   - Each activation is a config deploy with its own Gate 2.
5. **B3** → same path. Turn on `VITANA_INDEX_DUAL_COMPUTE_ENABLED`, which adds the final step to the existing 02:00 daily recompute.
   - **Cutover 1:** once Stage 1 is met, the `derived_device` cutover is its own Gate 2: Stage 1 report numbers, the commit list, and the note that this also activates device data in the Index (D6a). On "yes", deploy `HEALTH_FEATURES_SOURCE=derived_device` with C = deploy date + 1.
   - **Cutover 2:** later, once Stage 2 is met, the `derived` cutover is another Gate 2: Stage 2 numbers, the `consent_withheld` impact, and the commit list.
   - After each cutover the post-deploy check is health and build-info only, and the monitor runs 14 more days.
6. Rollback per Change 14 (owner-run or recorded authorization; one transaction; read-only verification afterwards). Decommission (stop legacy dual-writes, drop the bridge, W-sql, `user_integrations`, `health_features_daily_v2` → rename) is a separate later plan.

## Staging verification (read-only)
`docs/validation/<VTID>/staging-tests.json` per WP. The network guard aborts every non-GET except sign-in. No suite targets production.
- B1: `GET /api/v1/integrations` and `GET /api/v1/wearables/connections` → 200 JSON with the expected shape for the test user. `GET /api/v1/wearables/providers` → 200.
- B2: build-info commit. The B1 GETs again. `POST` paths are not probed; Jest proves them.
- B3: `GET /api/v1/admin/health/index-dual-compute/report` without a token → 401 JSON. With a non-admin test user → 403 JSON. The daily-recompute route is not called (write path); Jest proves the final step's staging block.

## Out of scope
- Package A's store, ingest endpoint, catalogue, partitions, retention and capacity model. Package C's Health Sync contract and wellness context. The consent store and withdrawal UI (B only consumes `hasHealthConsent` and A's change hook).
- Any change to the Vitana Index formula, `vitana_index_scores`, its 57+ readers, the calendar trigger, the browser self-heal RPC (F3), or the baseline-survey writer (F5).
- Re-routing lab writers (`log_biomarker`, partner ingestion): Phase 5.
- Moving tokens to KMS, and the dedicated key: deferred item from VTID-05030.
- Fixing W-sql, the legacy ingest RPC routes, and the broken `health_compute_vitana_index(date)` overload (F3, F9). They are recorded; B only stops calling W-sql in derived mode.
- History backfill into the store (not needed for Index parity; see Change 10). Gating self-logged legacy writes before the cutover. Decommissioning the legacy tables.

<!-- plan:end -->
