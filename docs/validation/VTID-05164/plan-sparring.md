# VTID-05164 — plan sparring record (Health Hub Phase 1 / C: Health Sync contract v1 and the wellness AI context module skeleton)

| | |
|---|---|
| VTID | **VTID-05164** — package C1 (Health Sync contract v1, ingest adapter over A2's `writeHealthSamples`, all new D10 consent keys, phone connector ids, A2's consent-key map filled, legacy ingest path closed) |
| Sibling VTIDs (same sparred plan) | C2 VTID-05165 (wellness context skeleton + purpose-boundary tests), C3 VTID-05166 (consent-category copy, vitana-v1) |
| Sibling packages (own records) | A VTID-05158–05160, B VTID-05161–05163 |
| Program | VTID-05020 (Health Hub plan v2) |
| Sparring session | `6be6c934-a23c-4e69-978e-77ea4a6586f2` |
| Partner | `plan-sparring-partner` agent (independent, read-only) |
| Change class | standard |
| Rounds | 3 |
| Verdict | **CONVERGED** |
| Plan hash, round 1 | `81fa94ab7eeb5adbaa46c644955de476527358a14f64e69aa666e8909aba6617` |
| Plan hash, round 2 | `2f3865925deec961de28ec3cb154268c0575139e12dcc3815e0f035a9d713f3d` |
| Plan hash, round 3 | `52fd8d239045b453c74cdc89e8fc75c3ea3a9b6b201bf00581f11d376628b271` |
| Plan hash, final | `522df112365dfa3c287c8b2a0292ff71b0c64b680768e61c8855836595bca0ba` |

Plan hash = sha256 of the UTF-8 text strictly between the `plan:begin` and `plan:end` HTML-comment markers in the
"Final plan" section below.

Owner approval: d.stevanovic@exafy.io in the Claude Code session — Gate 1 2026-10-13: Continue and make the decisions yourself (Gate 1 for Phase 1 A/B/C; planner defaults taken for every open question)

Planner defaults taken at Gate 1 (open questions of the plan): consent per category × per source (four `sync_*` keys,
two phone sources); the `sync_*` keys live in D10's catalogue; the legacy RPC closing stays with the PLAT-FIX revoke
(VTID-05156, already on main) and C1 only switches the 410 body; 0T runs as `production` with its own database and
JWKS; counsel wording gates C3 only; data catalogue v1 = activity, sleep, heart and body.

## Rounds

| Round | Finding | Answer | Where in the final plan |
|---|---|---|---|
| R1 | F1 — ordering and ownership of the `granted_via` CHECK against VTID-05092 | ACCEPTED — C1's migration is timestamped and merged strictly after 05092 and is the only Phase 1 migration touching that CHECK, as a strict superset | Change 11; Tests (migration) |
| R1 | F2 — D10's suites must stay green | ACCEPTED — VTID-05092's Jest and SQL suites run in the C1 PR | Tests ("D10 stays green") |
| R1 | F3 — C's tests must not depend on A's/B's internals | ACCEPTED — the Shared interfaces section is binding; port fakes only (A's S10 fake, an S6 fake) | Change 9; Tests |
| R1 | F5 — schema documentation | ACCEPTED — `DATABASE_SCHEMA.md` updated in C1 | Change 11 |
| R1 | F6 — load shedding before auth | ACCEPTED — per-IP limit before auth, per-member limit after | Change 2; Change 7 |
| R1 | F7 — C2 comparison logic | ACCEPTED — C2 implements two comparison functions with unit tests | Change 12 |
| R1 | F9 — deletions and withdrawal | ACCEPTED — deletions always pass through; A fires the S8 change hook | Change 4 |
| R2 | F1 — `connector_registry.category` CHECK has no phone-store category | ACCEPTED — the migration widens it as a superset with `health_store` | Change 11 |
| R2 | F2 — sequencing with B1's `health_sources.connector_id` FK | ACCEPTED — B1 merges before C1; phone-store creates fail closed until C1's rows exist | Change 11 |
| R2 | F3 — ratchet must be import-based | ACCEPTED — import-based ratchet; VTID-05025 stays the table-based guard | Change 13 |
| R3 | F1 — rollback statement still referred to a revoke C1 no longer ships | ACCEPTED — the migration is purely additive and needs no rollback SQL | Rollout 7 |
| R3 | — | CONVERGED | — |

The partner's verbatim output for every round is kept in the sparring session
`6be6c934-a23c-4e69-978e-77ea4a6586f2`; this table records the findings the final plan cites and the answer the planner
gave to each (round-1 F4 and F8 are recorded only in the session).

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard. One sparred plan, three VTIDs, merged in this order (placed in the program-wide order of Shared interfaces: A1 → B1 → A2 → A3 → C1 → C2 → B2 → B3 → C3):
  - **C1:** contract + ingest adapter + all new D10 consent keys + phone connector ids + closing the legacy ingest path (vitana-platform).
  - **C2:** wellness context skeleton + purpose-boundary tests (vitana-platform; after C1, because it needs the `sync_*` keys).
  - **C3:** consent-category copy keys (vitana-v1). Draft until counsel supplies the wording.
- **Program:** Health Hub plan v2 (VTID-05020) Phase 1, items "Health Sync contract v1" and "wellness context module
  skeleton" (`HEALTH-HUB-PLAN.md:171`). Sibling packages: A (store + ingest internals), B (`health_sources` merge, Index
  dual-compute). Companion: native app program VTID-05021, which implements the Health Sync module against this
  contract (`NATIVE-APP-PLAN.md:159-160`).
- **Hard dependencies:**
  - D10 WP1 (VTID-05092) merged: `hasHealthConsent` and `health_consent_categories`. C1's migration is timestamped
    and merged strictly after 05092 and is the only Phase 1 migration touching the `granted_via` CHECK (item 11).
  - D10 WP3 in production before the ingest flag is ever turned on.
  - A2 (S3 `writeHealthSamples`, S4 reads, S7 `findActiveHealthConsentId` and consent-key map) and B1 (S6 `resolveHealthSource`/`setHealthSourceState`) merged before C1 (Shared interfaces merge order). C1 answers `STORE_PENDING` until their tables are live.
  - 0T exists before any write-path test runs against a database (`HEALTH-HUB-PLAN.md:169`).
- **Repos / areas:**
  - vitana-platform:
    - `services/gateway/src/routes/health-ingest.ts` (new)
    - `services/gateway/src/services/health-sync/**` (new)
    - `services/gateway/src/services/wellness-context/**` (new)
    - `services/gateway/src/services/consent/health-consent.ts`, extended additively
    - `services/gateway/src/services/health-store/consent-gate.ts`: filling the S7 consent-key map entries only
    - `services/gateway/src/connectors/index.ts` (`apple_health`, `health_connect`)
    - `services/gateway/src/index.ts` (one mount + one path-scoped body parser)
    - `services/gateway/src/types/cicd.ts`
    - `services/gateway/src/routes/health.ts`: legacy route only
    - one additive migration and the Aurora parity scripts
    - `docs/programs/health-hub/HEALTH-SYNC-CONTRACT-v1.md` plus a machine-readable schema
  - vitana-v1: `src/i18n/<11 locales>/screens.json` (C3 only).
- **Regulatory impact:** this is the Art. 9 ingest entry point. Consent is per data category × per source and fails
  closed. Unconsented records are never stored, never archived and never quarantined. AI access goes only through the
  wellness module, gated by `ai_health_analysis`, carries only the program §2 pattern catalogue, and is never available
  to commerce. No medical-purpose output is added (no model call at all in C).
- **Database constraint:** staging shares the production database. The C1 migration is applied only after Gate 2.
  Every gateway change must work when the migration and A's/B's tables are absent, and in that state it fails closed.

## Facts (file:line, origin/main unless marked "D10 branch")
**Program and native app needs**
- F1 The program defines the ingest service as `POST /api/v1/health/ingest`: batch, gzip, gateway JWT, per-category
  consent, schema + plausibility validation, idempotency `(source_id, source_record_id)`, quarantine, per-member rate
  limit, raw batches in S3 for 30 days. One entry point for native, aggregator, partner and manual logs
  (`HEALTH-HUB-PLAN.md:101-104`).
- F2 Contract v1 must be frozen before native health work starts. It covers the device JWT from app login with the
  refresh token in Keychain/Keystore, the data catalogue (HealthKit/Health Connect → codes/units, 90-day backfill),
  anchors/change tokens, batching/retry/offline queue, consent before OS permission, and "OS permission revoked → source
  paused" (`HEALTH-HUB-PLAN.md:155-158`). The native plan uses supabase-js with the session in expo-secure-store
  (`NATIVE-APP-PLAN.md:151`) and implements the module against this contract (`:159-160`). It also adds a read-only
  `GET /api/v1/app-config` with a minimum supported version and fail-safe defaults (`:165-167`).
- F3 The wellness context is a new module, not an extension of `user-health-context.ts`, and covers consented
  categories only (`HEALTH-HUB-PLAN.md:128-131`). The allowed pattern catalogue is closed (`:69-72`). Voice prevention
  works by catalogue-only context plus intent-only rules (`:80-84`). Commerce may not import the wellness context
  (`:85-93`).
- F4 Health Hub tables go live in production only on Aurora, or behind the parity gate (`HEALTH-HUB-PLAN.md:118-121`).
  Until 0T exists: fixture tests only, staging ingest disabled by flag (`:169`).

**Gateway today**
- F5 There is a legacy ingest path with **no consent check**: `POST /api/v1/health/wearables/ingest`
  (`routes/health.ts:251`), mounted at `/api/v1/health` (`index.ts:1167`). It calls the RPC with
  `{p_provider, p_samples}` (`health.ts:285-288`, `health-repository.ts:29-30`), but the function's only signature is
  `health_ingest_wearable_samples(p_payload JSONB)`
  (`supabase/migrations/20251231000000_vtid_01078_health_brain_phase_c1.sql:636`). The named-argument call therefore
  cannot resolve, and the route answers 502 (`health.ts:304`). Reading the code, the route is dead; this has not been
  runtime-verified. **However**, the function is `SECURITY DEFINER` (`:639`) with
  `GRANT EXECUTE … TO authenticated` (`:722`). No later migration revokes it. Any signed-in browser can therefore write
  `wearable_samples` directly through PostgREST, bypassing every consent check. The D10 WP3 enforcement list (E1–E8)
  does not cover it. The only v1 reference is the generated types (`src/integrations/supabase/types.ts:13696`).
- F6 Body parsing: there is one global `express.json({limit:'2mb'})` (`index.ts:605`). Path-scoped raw parsers are
  placed before it for signed webhooks (`:602`). There is no JSON mapping for `entity.too.large`, so an oversize body
  gets the generic error handler. `delegatedTokenGuard()` keeps AI-delegated OAuth credentials off the REST API
  (`:609-610`).
- F7 `requireAuthWithTenant` (`middleware/auth-supabase-jwt.ts:660`) verifies the Supabase JWT, takes identity only
  from the token, and checks tenant membership. It answers 401 `UNAUTHENTICATED` and 400 `TENANT_REQUIRED` as JSON.
- F8 Environment identity: `VITANA_ENV` is `production|staging` only (`env.ts:13-21`). `isFeatureLive(...)` with
  `staging-only` turns a feature **on** for staging (`services/feature-flags.ts:81-88`), so it is not a safe gate for a
  write path. The established dark pattern is an exact `=== 'true'` env var **and** not staging
  (`services/wearable-features-bridge.ts:37-39`). The 409-on-staging precedent is
  `routes/scheduled-notifications.ts:1661-1662` (`mode === 'disabled-on-staging'`).
- F9 The rate-limit pattern is `express-rate-limit` (`routes/me-phone.ts:31-37`), with in-memory state per task.
- F10 Connectors: the registry (`connectors/index.ts:13-48`) holds no phone health-store source. `apple-health` is
  listed only as "unavailable" in `routes/integrations.ts:83` and in the waitlist (`routes/wearables-waitlist.ts:20`).
- F11 The route-file atlas: `^health` in the health domain already claims any `routes/health-*.ts`
  (`orb/developer/domain-atlas.ts:148`). The drift guard is `test/vtid-04560-role-separation-regression.test.ts`.
- F12 LLM locale: `buildLocalizedSystemPrompt(base, locale)` (`i18n/llm-locale.ts:82`) and
  `getUserLocale(supa, userId)` (`i18n/server-locale.ts:22`).
- F13 Purpose boundary: `test/vtid-05025-commerce-health-boundary.test.ts` lists the commerce modules (`:221-241`). It
  bans health tables by name (`:248`) and imports of `wearable-analyzer` and `wearable-features-bridge` (`:249-251`).
  `limitations-filter.ts` is the only allowed health→commerce module (`:298-300`). It knows nothing yet about a
  wellness module or A's new tables.

**D10 consent (D10 branch `fdfe5d039`, not yet on main)**
- F14 The category keys are a closed union of five (`services/consent/health-consent.ts:43-48`), mirrored by a static
  map (`:62-68`). `wearables` is `health_source/ingestion`, one consent per connector. `ai_health_analysis` is
  `health_category/processing`.
- F15 `hasHealthConsent(sb, identity, category, resourceId?)` returns a boolean and fails closed
  (`health-consent.ts:139-180`). It does not return the consent row id.
- F16 The grant route validates a `wearables` resource only against connectors in category `wearable|aggregator`
  (`routes/health-consent.ts:52-57, :124-126`). `apple_health` and `health_connect` would be rejected with
  `UNKNOWN_RESOURCE`.
- F17 `MEMBER_GRANTED_VIA = settings_privacy|settings_connected_apps|partner_link_confirm` (`health-consent.ts:85`). The
  migration seeds the catalogue (`supabase/migrations/…05092_health_consent_categories.sql:55-57`). Its CHECK on
  `resource_type` is `health_category|partner_integration|health_source` (`:36`). The catalogue guard test fails if
  `processing_active=true` has no listed enforcement point.
- F18 OASIS topics: `types/cicd.ts` has the topic union `export type CicdEventType =` (`:139`, ending `:1182`), with
  existing `health.*` members at `:260-264`. `emitOasisEvent(event: CicdOasisEvent)` (`services/oasis-event-service.ts:59`)
  is typed by it, so a new topic must be added to the union.

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
**C1 — Health Sync contract v1 + ingest adapter (vitana-platform)**

1. **The contract is a versioned artifact, not just code.**
   - `docs/programs/health-hub/HEALTH-SYNC-CONTRACT-v1.md` holds the prose for the native team.
   - `services/gateway/src/services/health-sync/contract-v1.ts` holds the zod schemas, the error-code enum and the
     HealthKit/Health Connect mapping of A's catalogue codes (S2) for the four sync categories; it is the single source
     of the external wire schema (S1). Codes, units, kinds and ranges are imported from A's catalogue, not redefined.
   - `contract-v1.schema.json` is generated from the zod schemas. A lock test records its sha256. A changed schema
     without a minor or major version bump fails CI, mirroring D10's wording lock.
2. **Endpoints.** A new router `routes/health-ingest.ts` is mounted at `/api/v1/health/ingest`. It is claimed by
   `^health` in the atlas (F11), and its paths do not collide with the existing `/api/v1/health` router (F5).
   - `GET /contract`: no auth, read-only. Returns `{contract_version:"1.0", supported_majors:[1], max_minor:0,
     catalogue, limits, error_codes}` so the app can self-check at start.
   - `POST /`: one batch (item 3). Order of checks:
     1. Ingest gate: `HEALTH_SYNC_INGEST_ENABLED === 'true' && VITANA_ENV !== 'staging'`. Otherwise **409**
        `{error:'INGEST_DISABLED', reason:'staging'|'flag_off', retryable:false}`. Nothing is read or written (F8).
     2. Per-IP rate limit. It runs **before** auth, so unauthenticated load is shed before any JWT verification or
        DB lookup (round-1 F6).
     3. `requireAuthWithTenant` (F7).
     4. Per-member rate limit, keyed by the JWT `user_id`, **after** auth.
     5. Decode and validate.
     6. Resolve the source through B.
     7. Consent per category (item 4).
     8. Hand off to A.
   - `GET /status?source_kind=&install_id=`: auth, read-only. Returns the source state (through B), the member's
     consent state for each sync category on that source, `ingest_enabled`, and A's store state as
     `store:{enabled, reason}` (`getHealthStoreStatus()`). On staging it reports
     `ingest_enabled:false` and stays readable.
   - `POST /source-state` `{source_kind, install_id, state:'os_permission_revoked'|'active', permitted_categories[]}`
     implements "OS permission revoked → source paused" by calling B's `setHealthSourceState` (S6: `paused` with
     `reason_code:'OS_PERMISSION_REVOKED'`; `active` → `connected`). It has the same ingest
     gate (409 on staging).
3. **Batch format v1.** The request is `Content-Type: application/json`, optionally `Content-Encoding: gzip`:
   ```
   { contract_version: "1.0",
     batch_id: uuid (app-generated, stable across retries),
     source: { kind: "apple_health"|"health_connect", install_id: uuid, platform: "ios"|"android",
               os_version, app_version, device?: { manufacturer?, model? } },
     sync_mode: "incremental"|"backfill",
     records: [ { record_id, type (catalogue code, S2),
                  value?: number, stats?: {n, sum, min, max}, unit (UCUM, must equal the catalogue unit),
                  start, end (ISO-8601 with offset), tz (IANA), origin_app_id? } ],   // 0..1000
     deletions: [ { record_id, type } ]                      // 0..1000
   }
   ```
   - **Device pre-aggregation (S1):** for `series_sum`/`series_stats` codes the app sends one item per aligned UTC
     interval (5 minutes within the last 30 days, 1 hour when older), computed with HealthKit statistics collection
     queries / Health Connect aggregate by duration, `record_id = "<type>:<start UTC>"`, `value` (sum) or `stats`;
     a changed interval is re-sent whole, an emptied one is sent as a deletion. `record` codes send one item per OS
     object with `record_id` = HKObject UUID / Health Connect `metadata.id`.
   - The schema is strict: unknown fields give 400 `INVALID_BATCH` with `details[{path,code}]`.
   - There is no `user_id` or `tenant_id` field at all. Identity comes only from the JWT.
   - Parsing: a path-scoped `express.raw({type:'*/*', inflate:false, limit:'512kb'})` is mounted before the global
     JSON parser (F6), the same pattern as the webhook mount. The route gunzips with `maxOutputLength` 4 MB
     (zip-bomb safe) and parses the JSON itself. A path-scoped error middleware maps `entity.too.large` to 413
     `BATCH_TOO_LARGE`.
   - **Data catalogue v1** (closed): four consent categories, each listing its codes, the HealthKit identifier, the
     Health Connect record type, the UCUM unit and a plausibility range:
     - `activity`: steps, active energy, exercise minutes, distance, workouts.
     - `sleep`: sleep session and stages.
     - `heart`: resting HR, HRV SDNN/RMSSD, HR.
     - `body`: weight, body fat %.
   - Anything else gets a per-record `UNSUPPORTED_TYPE`. **Blood glucose / CGM, reproductive and clinical records are
     explicitly excluded** (program §2 and owner decision 7). The app must not request OS permission for them.
4. **Per-category consent, fail closed.**
   - Consent is checked per (category × source): four new D10 catalogue keys, `sync_activity`, `sync_sleep`,
     `sync_heart` and `sync_body`. Each is `resource_type='health_source'`, `scope='ingestion:<category>'`,
     `per_resource=true` (resource = `apple_health` | `health_connect` | an aggregator id), and
     `processing_active=true`, because this route is their enforcement point (satisfies F17's guard).
   - C1 also adds `self_logged_health` for diary, voice and manual sources: `resource_type='health_category'`,
     `scope='ingestion:self_logged'`, `per_resource=false`, enforced in A's gate (S7). C1 owns all five new keys.
   - Additive changes in `health-consent.ts`:
     - extend the union and the static map (F14);
     - add `HEALTH_SYNC_SOURCE_KINDS`, which the grant route accepts as resources for `sync_*` keys (fixes F16);
     - add `granted_via='native_health_sync'`;
     - use A2's `findActiveHealthConsentId(...)` (S7), which returns the row id (A stores it as `consent_id`, program
       §3.3; F15); C1 does not add a second one. **`consent_id` is provenance and audit only** (it records which
       grant a row was ingested under). Withdrawal does not work by invalidating rows by `consent_id`; its effects
       come from A's suppress primitives (S9, `suppressHealthData`), wired by the Phase 1 consent package (planner Q1);
     - fill the S7 consent-key map entries in A's `consent-gate.ts` for the five new keys;
     - register `apple_health` and `health_connect` as connector ids (code registry and `connector_registry` rows).
   - The adapter checks each category present in the batch **once** (at most 4 reads).
   - A record whose category lacks consent is rejected per record with `CATEGORY_NOT_CONSENTED`. It is **dropped
     before A is called**, so it never reaches A's store, quarantine or S3 raw archive.
   - If no category in the batch is consented, the whole batch answers **403** `CONSENT_REQUIRED` with
     `categories:[...]`.
   - Deletions are always passed through, whatever the consent state: withdrawing consent must never block removing
     data. A processes them and fires the S8 change hook for committed deletions (Shared interfaces decision 7;
     round-1 F9).
   - Contract rule: on `CATEGORY_NOT_CONSENTED` the app purges its queued records for that category and stops reading
     it.
5. **Idempotency and sync semantics.**
   - Batch level: `(user_id, batch_id)`. **A stores the batch receipt**: `(user_id, batch_id)` → outcome plus
     normalised-content hash (S3, `health_ingest_batches`). C keeps no receipt of its own and relies on it (planner
     Q2). A replay returns the original outcome with `replay:true`, and nothing is written twice. The same `batch_id`
     with different content answers 409 `BATCH_ID_REUSED`.
   - Record level: `(source_id, record_id)`. A resend gives `duplicate`. A changed value with the same `record_id`
     gives `updated` (HealthKit/Health Connect edits, or a re-sent interval). For series items `record_id` is the
     interval key (S1), so this is the same rule as A's bucket replace.
   - Anchors and change tokens stay **on the device**; the server keeps no cursor. The app advances its anchor only
     after a 200, whatever the per-record outcomes. Per-record rejection codes are all **non-retryable** by
     definition. Only batch-level errors can be retryable.
   - Backfill defaults to 90 days. The server rejects `start` older than 400 days or `end` more than 5 minutes in the
     future (`OUT_OF_WINDOW`).
6. **Response and error codes** (never raw DB or vendor messages).
   - 200 response:
     ```
     {ok:true, batch_id, replay, counts:{stored,duplicate,updated,deleted,rejected},
      rejected:[{record_id, code}], consent:{activity|sleep|heart|body:'granted'|'not_granted'},
      source_state}
     ```
   - Per-record codes: `UNSUPPORTED_TYPE`, `UNIT_MISMATCH`, `IMPLAUSIBLE_VALUE` (sent to A's quarantine),
     `OUT_OF_WINDOW`, `CATEGORY_NOT_CONSENTED`, `INVALID_RECORD`.
   - Batch codes. Every body has `{ok:false, error, retryable, retry_after_s?, details?}`:

     | Code | Status | Retryable |
     |---|---|---|
     | `INVALID_BATCH` | 400 | no |
     | `UNSUPPORTED_CONTRACT_VERSION` | 400 | no; carries `supported_majors` |
     | `UNAUTHENTICATED` | 401 | the app refreshes once, then retries |
     | `TENANT_REQUIRED` | 400 | no |
     | `CONSENT_REQUIRED` | 403 | no |
     | `SOURCE_PAUSED` | 409 | no; the app stops until the member re-enables |
     | `INGEST_DISABLED` | 409 | no |
     | `BATCH_ID_REUSED` | 409 | no; the app sends a new `batch_id` |
     | `BATCH_TOO_LARGE` | 413 | no; the app splits the batch |
     | `UNSUPPORTED_ENCODING` | 415 | no |
     | `RATE_LIMITED` | 429 | yes, after `Retry-After` |
     | `STORE_PENDING` | 503 | yes, with back-off; A's or B's tables are absent |
     | `STORE_UNAVAILABLE` | 503 | yes |
7. **Device auth.**
   - Auth is the member's Supabase access token (`Authorization: Bearer`). The refresh token is held by supabase-js
     in Keychain/Keystore (F2) and never in web storage.
   - Background tasks refresh before sending. On 401 the app refreshes once and retries; a second 401 pauses the sync
     until the next foreground session.
   - `install_id` is an app-generated UUID, persisted in secure storage and used only to tell sources apart. It is
     not a credential.
   - AI-delegated tokens are already refused by `delegatedTokenGuard` (F6). A Jest test pins this for the new path.
   - No service-role or staff path writes for a member.
   - **Rate limits:** two limiters in this order. First a per-IP backstop **before** auth (sheds unauthenticated
     load). Then a per-member limit **after** auth, keyed by `user_id` (defaults: 120 batches/hour, 10 concurrent).
     Both are in-memory per task (F9), so the limits are approximate. They are config values that A's capacity model
     may change.
8. **Versioning.**
   - `contract_version` is "major.minor". The server accepts major 1 with any minor ≤ its own `max_minor`.
   - Minor versions only add optional fields or catalogue codes, and the server ships them first. Because the schema
     is strict, an app must not send fields newer than `GET /contract` reports.
   - A major version change means a new schema, served alongside the old one until adoption has passed the threshold.
     The minimum app version is enforced through the native program's `GET /api/v1/app-config` (F2), not here.
   - The JSON schema lock (item 1) makes every change explicit.
9. **Adapter → A and B.** C's `processHealthSyncBatch(identity, batch, {channel:'native'|'aggregator'})` maps a
   validated v1 batch into S3's `writeHealthSamples` input (`via:'health_sync_native'|'health_sync_aggregator'`,
   consented records only as `samples`, all `deletions`) and maps the result back to wire codes with the S3 mapping
   table in Shared interfaces. It resolves the source with S6 `resolveHealthSource(…, {kind:'phone_store',
   connector_id, provider_user_id:install_id, create:true})`. Everything C needs from A (S2–S5, S7) and from B (S6)
   is specified there; C adds no further requirement.
   - **The Shared interfaces section is the binding contract between A, B and C (round-1 F3).** C's code and tests
     depend only on the S-interfaces as written there. C's tests use in-memory fakes of A's and B's ports only: A's
     S10 fake (`health-store/testing/fake-health-store.ts`) and an S6 fake of B's three functions. They never import
     A's or B's internal types or repositories. A shape change in A or B is made in the Shared interfaces section
     first and then means updating the fakes. C's tests catch the change through the fakes, not through A's or B's
     internals.
   - **Aggregator:** C defines only `AggregatorBatchAdapter`, which maps a verified webhook's normalised events into
     a v1 batch and calls `processHealthSyncBatch` with `channel:'aggregator'`. The vendor is chosen in Phase 2, so C
     ships just the interface plus a fixture adapter for tests.
   - **The legacy Terra/Vital webhook path (`routes/connector-webhooks.ts`) is not rerouted in C** (planner Q3). It
     is consent-gated by D10 WP3 enforcement point E2 (VTID-05094): no `wearables` consent means no row and no
     payload. It is rerouted onto `processHealthSyncBatch` in Phase 2. Once WP3 is live, it does not bypass consent.
10. **OASIS.**
    - Add `health.sync.batch.processed`, `health.sync.batch.rejected`, `health.sync.source.paused` and
      `health.sync.source.resumed` to the `CicdEventType` topic union in `types/cicd.ts` (F18; verified to exist,
      `:139-1182`, with the existing `health.*` members at `:260-264`). `emitOasisEvent` takes that type, so an
      undeclared topic fails `tsc`.
    - Payloads carry `batch_id`, source kind, category names, counts and error codes, **never a health value or a
      record id**.
    - An emit failure is logged and never fails the batch.
11. **Close the parallel, consent-free ingest path (F5).**
    - The legacy route's 410 and the EXECUTE revoke on `health_ingest_wearable_samples(jsonb)` are delivered earlier by
      the Health Hub fix-ups plan (PLAT-FIX, defect 5), so C1 does not repeat them; C1 only switches the 410 body to
      `{error:'SUPERSEDED', use:'/api/v1/health/ingest'}` and its migration test asserts the revoke is in place.
    - **C1's single migration** adds:
      - the five new catalogue rows (four `sync_*` and `self_logged_health`, S7);
      - the `apple_health` and `health_connect` `connector_registry` rows, with `auth_type='sdk_bridge'` (already
        allowed) and a new category `health_store`: the migration widens the `connector_registry.category` CHECK as a
        superset (`social, wearable, shop, calendar, productivity, aggregator, ai_assistant` + `health_store`;
        migrations `20260417000000…:16`, `20260419000000…:40`) (round-2 F1);
      - the `granted_via` value `native_health_sync`.
    - **Ordering and ownership of the `granted_via` CHECK (round-1 F1).** The migration's timestamp and merge come
      strictly **after** VTID-05092 (D10 WP1) has merged, because it builds on 05092's catalogue table and its
      replaced CHECK. It is the **only** Phase 1 migration that touches the `granted_via` CHECK. It drops the
      constraint and re-adds it as a strict **superset**: every value 05092 allows plus `native_health_sync`. A
      migration test asserts that superset.
    - The Aurora parity scripts are updated in the same PR.
    - **`DATABASE_SCHEMA.md` is updated in C1** (round-1 F5; platform ALWAYS rule 24). It covers the new catalogue
      rows, the connector rows, the `granted_via` value and the widened category CHECK.
    - **Sequencing with B1 (round-2 F2):** B1 merges before C1. `health_sources.connector_id` is nullable and keeps its
      FK to `connector_registry(id)` (shared section); B1's `resolveHealthSource` answers `STORE_UNAVAILABLE` for a
      phone-store create until C1's `apple_health`/`health_connect` rows exist, so no phone-store row is ever inserted
      before C1, and device-cloud rows reference connectors that already exist.
    - `health_ingest_lab_report` has the same shape. It is listed for Phase 5 and not changed here.

**C2 — wellness AI context module skeleton (vitana-platform)**

12. New `services/gateway/src/services/wellness-context/`:
    - `buildWellnessContext(sb, identity, {purpose})` takes `purpose ∈ {'wellness_chat','wellness_recommendation'}`,
      a closed union with **no commerce member**. It returns `{status:'disabled'|'consent_required'|'empty'|'ok',
      locale, facts[]}`.
      - Dark gate: `WELLNESS_CONTEXT_ENABLED === 'true'`.
      - It requires `ai_health_analysis`, and per fact the matching `sync_<category>` consent on at least one source.
        A withdrawn category is excluded at the next call, because nothing is cached.
      - `locale` comes from `getUserLocale` (F12).
      - `facts` use a closed `WellnessFactKind`, taken 1:1 from the §2 catalogue: `sleep_duration_vs_baseline`,
        `sleep_regularity`, `activity_volume`, `activity_streak`, `recovery_trend` (resting HR/HRV vs own baseline),
        `weight_trend`, `logged_habit`.
      - **C2 implements the comparison logic** for `sleep_duration_vs_baseline` and `activity_volume` (round-1 F7):
        pure functions computing the 7-day mean against the member's own 30-day mean, a direction and a minimum-data
        rule. They are unit-tested on fixture rows.
      - **The data read goes only through A's `readDailyObservations` port** (S4, `purpose:'ai_context'`). Until A
        ships, the port answers `STORE_PENDING` or empty rows, and the module returns `status:'empty'` without
        throwing. The other kinds are typed and return nothing until the Phase 1 feature layer and Phase 4.
    - `buildWellnessSystemPrompt(basePrompt, ctx)` renders the facts as a data block plus the boundary rules, written
      as English **intent**:
      - no condition names;
      - no risk statements;
      - no alerts;
      - suggest talking to a doctor when unsure.

      There are no finished sentences and no per-language strings (NEVER rule 41). The function always wraps the
      result with `buildLocalizedSystemPrompt(..., ctx.locale)`, so a consumer cannot skip the locale rule.
    - No model call in C2, and no consumer is wired. Phase 4 consumers call Claude through the Bedrock router only.
13. **Purpose boundary and only-path tests.**
    - The `vtid-05025` scan (F13) is extended: commerce modules may not import `wellness-context`, and A's
      `HEALTH_STORE_TABLES` join the banned-table pattern.
    - A new `wellness-context-boundary.test.ts`:
      - (a) `wellness-context` has no importers outside an allowlist, which is empty in C2 except tests.
      - (b) `wellness-context` imports no commerce module and no provider SDK (`@google*`, `vertex`, `openai`,
        `@anthropic-ai/sdk`).
      - (c) A's tables (`HEALTH_STORE_TABLES`, S5) are referenced only inside `services/health-store/**`;
        `wellness-context` reads only through S4.
      - (d) A **ratchet list** names today's legacy AI readers of device/lab data, which D10 WP3 gates
        (`user-health-context.ts` wearable branch, `gemini-operator` `get_wearable_metrics`, `health-depth-tools`
        lab tool, `wearable-analyzer`). The list may only shrink; adding a reader fails. The ratchet is
        **import-based** (direct importers of those modules, so `context-pack-builder.ts`, which imports
        `user-health-context.ts`, is on the list and cannot add another), and the existing VTID-05025 scan stays the
        **table-based** guard for commerce modules (round-2 F3).
      - (e) The rendered prompt for fixture facts contains no term from a disease/condition denylist in any of the 11
        locales' catalogue names.

**C3 — consent copy (vitana-v1)**

14. Add the four `sync_*` categories and `self_logged_health` to D10 WP2's versioned consent keys: `screens.settings.healthConsent.<key>.v1.*`,
    DE first, with counsel-supplied wording only, plus chrome labels. The D10 lock manifest covers them. The Settings ›
    Privacy "connected sources" list renders them from the catalogue, so members can withdraw on the web what they
    granted in the app. C3 stays draft until the wording exists. The native app reuses the same keys through the
    shared i18n shards.

## Tests
- **C1 Jest (gateway):**
  - Gate: 409 `INGEST_DISABLED` on staging even with the flag set, and with the flag unset in production; neither
    reads the body or calls A, B or the DB.
  - Auth: 401 without a token, JWT identity only, a body `user_id` is rejected (strict schema), and a delegated token
    is refused.
  - Schema: every error code with a fixture; gzip happy path; gzip bomb gets 413 `BATCH_TOO_LARGE`; unknown field and
    unknown major are covered.
  - Consent:
    - per-category drop, where A receives none of the unconsented records (spy on the A port, including the
      `samples` it receives, which are also A's only archive and quarantine input, S3);
    - all unconsented gives 403;
    - deletions pass through without consent;
    - a consent read error is treated as not granted.
  - Idempotency (A port fake): batch replay gives `replay:true`; record resend gives `duplicate`; same id with a new
    value gives `updated`.
  - `STORE_PENDING` when A or B report absent tables.
  - Rate limiters: the per-IP limiter answers 429 before auth runs (the JWT verifier is not called); the per-member
    limiter runs after auth. Both give 429 with `Retry-After`.
  - OASIS payload contains no value and no record id.
  - Legacy route gives 410.
- **C1 contract tests:**
  - The schema lock hash.
  - The catalogue covers every listed HealthKit/Health Connect type with a UCUM unit and range.
  - Glucose/CGM codes are absent.
  - A golden request/response fixture set is published in `docs/` for the native team's own contract tests.
- **Port fakes only (round-1 F3):** every C1 and C2 test that touches A or B uses A's S10 fake and an S6 fake. No test
  imports A's or B's internal types or repositories.
- **D10 stays green (round-1 F2):** VTID-05092's suites run unchanged in the C1 PR and pass. That is
  `test/consent/health-consent.test.ts`, `test/consent/health-consent-premigration.test.ts`,
  `test/routes/health-consent.test.ts`, `test/migrations/vtid-05092-health-consent-migration.test.ts`,
  `test/partner-health-consent.test.ts` and `scripts/ci/sql-tests/vtid-05092-health-consent.test.sql`. This proves the
  additive export (A2's `findActiveHealthConsentId`, which C uses) and C1's union, map and catalogue extensions
  change no existing behaviour.
- **C1 migration test:**
  - The five seed rows and the two `connector_registry` rows.
  - The `granted_via` CHECK is a superset of VTID-05092's values plus `native_health_sync`.
  - The revoke of EXECUTE from `PUBLIC`, `anon` and `authenticated`.
  - The D10 catalogue guard stays green (`processing_active` ⇒ enforcement point = `routes/health-ingest.ts`).
  - SQL test in `scripts/ci/sql-tests/` (local Postgres).
- **C2 Jest:**
  - Flag off gives `disabled`; no `ai_health_analysis` gives `consent_required` and A's read port is not called.
  - The comparison functions on fixture rows: direction, too little data gives no fact.
  - The read port answering `STORE_PENDING` or empty gives `status:'empty'`, with no throw.
  - A withdrawn `sync_sleep` removes the sleep fact.
  - Only `WellnessFactKind` values appear.
  - The prompt is always locale-wrapped (11 locales).
  - The boundary and ratchet tests (item 13).
- `npm run test:support`, `test:operator` and `test:roles` stay green (the atlas claims the new route file).
- No test writes to the shared database. Write paths are proven with fakes and local Postgres, and in 0T once it
  exists.

## Rollout
1. Spar this plan, then Gate 1. Allocate C1, C2 and C3, citing the sparring record. C1 waits for VTID-05092, A2 and B1 to merge (its migration strictly after 05092's, item 11);
   C2 follows C1 (Shared interfaces merge order).
2. C1 PR → merge → staging. On staging, POST and source-state answer 409, and `GET /contract` and `GET /status` are
   readable. Then STAGING-VERIFY → Gate 2. On "yes": apply the C1 migration to production, then dispatch the gateway
   pinned to the verified commit. `HEALTH_SYNC_INGEST_ENABLED` stays **unset** everywhere.
3. C2 PR → staging → Gate 2 → production, with `WELLNESS_CONTEXT_ENABLED` unset everywhere and no consumer.
4. C3 draft until counsel wording, then staging → Gate 2 → production.
5. The contract is frozen (v1.0) when C1 merges. The native team builds against the golden fixtures and later 0T.
6. Turning the ingest flag on in production is **not part of this plan**. It needs its own Gate 2, after all of the
   following hold:
   - A's and B's tables are live on Aurora (or the parity gate is met);
   - D10 WP3 is in production;
   - the DPIA is done;
   - the 0T end-to-end run has passed;
   - a native build exists.
7. Rollback: redeploy the previous commit. The migration is purely additive (catalogue rows, connector rows, a wider
   category CHECK, a new `granted_via` value) and needs no rollback SQL (round-3 F1).

## Staging verification (read-only)
`docs/validation/<VTID>/staging-tests.json`. The network guard aborts every non-GET except sign-in.
- C1:
  - `GET /api/v1/health/ingest/contract` gives 200 JSON with `contract_version:"1.0"`, four categories and no glucose
    code.
  - `GET /api/v1/health/ingest/status` without a token gives 401 JSON. With the test user it gives 200 with
    `ingest_enabled:false`, and `store_pending` either way.
  - The build-info commit matches.
  - The 409 on POST is proven by Jest, not on staging.
- C2: build-info commit only (no route). The behaviour is proven by Jest.
- C3 (Playwright, preview-aws): the Privacy connected-sources list renders the five new keys off for the test user;
  the dialog opens and is closed without granting. Includes a mobile and an `ar` RTL screenshot.

## Out of scope
- A's internals: tables, aggregation, partitions, S3 archive, quarantine table, capacity model (program F7).
- B's `health_sources` merge and Index dual-compute.
- Partner, lab, diary, voice and manual writers. These call A server-side (Phase 1 writer re-routing / Phase 5) and
  are not clients of the external contract.
- The native Health Sync module itself (native program).
- The aggregator vendor and adapter (Phase 2).
- `health_ingest_lab_report` hardening (Phase 5).
- Withdrawal "keep vs delete history" (Phase 1 consent package, §3.6).
- Rerouting the legacy AI readers into the wellness module (Phase 4); the ratchet only freezes them.
- Any LLM call, output guard or golden sets (Phase 4).
- Write-back to HealthKit or Health Connect.

<!-- plan:end -->
