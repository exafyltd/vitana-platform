# Vitanaland Health Hub — plan v2 (health data integration)

Planner: Claude Code session, 2026-10-06. Supersedes the unmerged VTID-04538 plan
(`docs/HEALTH-DATA-INTEGRATION-PLAN.md` on the old `claude/health-data-integration-plan-dbxyld` commit 8b074f08b).
Revision: r7 (owner correction 2026-10-10: Aurora is the platform database, Supabase Auth stays; re-sparred).

<!-- plan:begin -->

## Meta
- **Change class:** standard (program plan; each phase becomes its own sparred plan + VTID before code).
- **Scope (areas):** vitana-platform `services/gateway/src/{connectors,routes,services}` (incl. `user-health-context.ts`,
  `recommendation-engine/**`, `context-pack-builder.ts`, discover/shopping-agent consumers), `supabase/migrations`, new
  ingest/feature/AI-context services; vitana-v1 `src/pages/settings/{ConnectedApps,Privacy}.tsx`, `src/components/health/**`,
  `supabase/functions/request-account-deletion`; new native mobile project(s) (owned by the parallel native-app effort, §4).
- **Goal:** Vitanaland becomes a consumer **health data hub**: members connect phone health stores, wearables, labs and
  other apps; data lands in one consented store; the AI gives personal **wellness/lifestyle** guidance from it.
  Vitanaland is **not** a medical device and provides no medical service.

## 1. Current state (verified on origin/main 2026-10-06: platform e9818e650, v1 e45fee2f9)
Exists:
- Connector framework under `services/gateway/src/connectors/{wearable,health}/` (terra, vital, fitbit, oura, strava,
  doctorbox) plus SMART-on-FHIR OAuth; routes `/api/v1/wearables/*`, `/api/v1/connectors/webhook/:id`,
  `/api/v1/wearables/waitlist`.
- A second, parallel integration model: `/api/v1/integrations` + `user_integrations` (migration `20260423200000`),
  which lists `apple-health` as unavailable, and `/integrations/manual/log`.
- Tables `user_connections`, `wearable_daily_metrics`, `wearable_workouts`, `wearable_samples`, `health_features_daily`,
  `vitana_index_scores`, `biometric_trends`, `biometric_events`, `lab_reports`, `biomarker_results`,
  `connector_webhooks_log`; partner-health result ingestion with quarantine inbox (VTID-03885).
- Account erasure `erase_user_data()` (VTID-04765) covering every public table with a non-cascading uuid `user_id`.
- Art. 9 `special_category` flag on memory rows (VTID-04798). Partner Terms v1 text, not yet published (VTID-04895/04911).
Defects (still live):
- D1 Tokens: `user_connections.access_token/refresh_token` plain TEXT (migration `20260417000000` L61-62, written raw at
  `routes/wearables.ts` L212-213) **and** `authenticated` holds SELECT/INSERT/UPDATE on the table (same migration L266-273,
  L301), so a browser session can read its tokens and forge its own connection rows. Disconnect only sets `is_active=false`
  (`wearables-repository.ts` L38-40); tokens are never cleared or revoked at the vendor.
- D2 Webhooks: Terra/Vital/DoctorBox return true when the secret is unset (`connectors/wearable/terra.ts` L53-57,
  `connectors/wearable/vital.ts` L48-51, `connectors/health/doctorbox.ts` L52-55); Vital's check does not follow the Svix
  scheme (`vital.ts` L58), Terra has no timestamp tolerance (`terra.ts` L67-72), DoctorBox has no real spec.
- D3 `ConnectedApps.tsx` health cards hard-coded `connected: true` (L372, L381, L414); nothing in v1 calls `/api/v1/wearables`.
- D4 `Privacy.tsx` health/insights/third-party switches uncontrolled (L282, L289, L296); two are `defaultChecked`
  (they display health-data sharing as on without consent); export button at L374 has no handler.
- D5 Erasure misses the `health-reports` storage bucket, `partner_health_result_inbox` (no `user_id`) and
  `connector_webhooks_log` (payloads stored with nullable `user_id`, no retention); no vendor token revocation.
- D6 Wearable data feeds `user-health-context.ts` (L351-364) but not `health_features_daily`/Vitana Index;
  `health_compute_features_daily` reads only `wearable_samples`; no sync scheduler; `fetchData` never called.
- D7 Lab uploads stay `uploaded`; AP-0607 sends "being analyzed" and emits `health.biomarkers.stored` with no parser
  (`automation-handlers/health-wellness.ts` L83-91).
- D8 `admin-partner-health.ts`: `confirm-match` (L350) links a member without member confirmation; staff reads
  `/orders`, `/inbox`, `/candidates` unaudited; only a doctorbox adapter, `partner_key` falls back to doctorbox (L264).
- D9 `dpa` is a required onboarding step for lab/practitioner_clinic but cannot be completed (no `/dpa/sign`, no AVV text).
- D10 No per-category health consent; `data_sharing_consents` only used for `partner_integration`.
- D11 Mobile is an Appilix WebView (`src/lib/appilix.ts`); no native project exists. Apple Health / Health Connect unreachable.
- **D12 Health → commerce path:** `inferPrimaryCondition()` (`user-health-context.ts` L409-433) labels members
  `insomnia` (sleep < 360 min) or `low-hrv` (HRV < 40 ms) from wearable data; `marketplace-analyzer.ts` L235 ranks products
  by it; `user-health-context` is also imported by `feed-ranker`, `discover-search`, `discover-feed`, `shopping-agent`,
  marketplace ORB tools, `context-pack-builder`, `gemini-operator`, `orb-tools/health-depth-tools` and
  `limitations-filter.ts` (the hide-only product safety filter for allergies, contraindications and medications, which must keep working). This is a device-data disease label (outside the wellness boundary)
  feeding commerce (contrary to Apple 5.1.3 and Health Connect policy).

## 2. Regulatory frame — wellness hub, not medical device
- **Intended purpose** (counsel sign-off; used verbatim in terms, store listings, marketing): "Vitanaland helps members
  collect and understand their own lifestyle and wellbeing data and supports healthy habits. It does not diagnose, treat,
  monitor or predict disease and does not replace medical advice."
- Outside MDR 2017/745 only while product, copy and AI output stay inside that purpose (MDCG 2019-11).
  **Allowed:** collect, store, chart; lab values with the lab's own reference range; personal patterns vs the member's
  own baseline; lifestyle suggestions; "consider discussing with a doctor"; member-chosen sharing with a practitioner.
  **Not allowed:** diagnosis/condition labels derived from data (incl. D12), disease-risk statements, own clinical
  thresholds, physiological alerts/push notifications, medication or dosing advice, triage, clinician decision support.
- **Allowed pattern catalogue** (closed list; anything else needs counsel): sleep duration/regularity vs own baseline,
  activity volume/streaks, resting-HR and HRV trend vs own baseline described as "recovery", weight trend, logged
  habits. Shown in-app only, never as push alerts, never with disease words. **CGM is out of scope** until counsel signs off.
- **Still applies:** GDPR Art. 9 (explicit consent, DPIA Art. 35, DPO Art. 37, Art. 28 DPAs, Art. 30 records, rights),
  EU AI Act Art. 50 transparency, HWG/UWG for commerce copy, Apple 5.1.3 / HealthKit terms, Google Play Health Connect
  policy. Partners provide medical services under their own licence; Vitanaland is platform, and processor where it hosts partner data.
- **Engineering guardrails:**
  (a) **AI output guard, split by channel.**
  *Text* (chat, recommendation cards, notifications): a claim check (pattern list + Bedrock classifier, latency budget
  ≤ 800 ms p95, pattern check alone runs first) before display; on a block the output is replaced by a fixed catalogue
  referral (`tt()` key), never an LLM rewrite; fails closed (referral shown) if the classifier is unavailable.
  *Voice* (Nova Sonic, cascade, Vertex bridges — audio reaches the member before text exists, so no pre-check is
  possible): prevention instead — only §2-catalogue patterns and consented categories enter the wellness context
  injected into the prompt; the boundary rules are written as intent in the system instruction (NEVER rule 41); a
  post-hoc transcript audit classifies every health-related voice turn, counts escapes and feeds regressions into the
  golden sets. Per-locale golden tests in CI for both channels.
  (b) **Purpose boundary enforced in CI:** a test/lint rule forbids commerce modules (`recommendation-engine/**`
  marketplace analyzers, `feed-ranker`, `discover-*`, `shopping-agent/**`, marketplace ORB tools) from importing the
  wellness health context or reading health tables. Device-derived data never reaches commerce.
  **Single carve-out — safety filter:** member-stated safety constraints (allergies, contraindications, current
  medications, pregnancy) may reach commerce **only** inside `limitations-filter.ts`, as a hide-only filter: never used
  to rank, promote, target or log for analytics, never device-derived. The CI boundary test names it as the only allowed
  module, and a test asserts its output can only remove products, never reorder or add them. Its legal basis is recorded
  with owner decision 2. Whether member-stated conditions may *personalise* (rank/recommend) commerce under a separate
  explicit opt-in is owner decision 2.
  (c) Copy rules + review checklist; (d) "regulatory impact" field on every future health plan.

## 3. Target architecture
1. **Sources.** Phone stores (HealthKit, Health Connect) via native module (§4) — these also carry Oura, Withings, Garmin,
   Polar, Samsung data the member already syncs to the phone; cloud: **one EU-hosted aggregator** for v1 (devices
   not reaching the phone stores); existing direct connectors (fitbit, oura, strava) frozen, not extended; labs/partners via
   FHIR R4 + portal upload; documents via parser; existing manual/voice/diary paths.
2. **Ingest service** `POST /api/v1/health/ingest` (batch, gzip): gateway JWT auth, per-category consent check, schema +
   plausibility validation, idempotency `(source_id, source_record_id)`, quarantine table on failure, per-member rate
   limit. Raw batches stored encrypted in S3 (eu-central-1) for 30 days for reprocessing, not in Postgres. Same entry point
   for native module, aggregator webhooks, partner results and manual/voice/diary logs.
3. **Canonical store.** All tables carry `tenant_id uuid not null`, `user_id uuid not null`; RLS SELECT
   `user_id = auth.uid()` only; **no INSERT/UPDATE/DELETE grant to `authenticated`** (writes only via gateway).
   - `health_observations`: code (LOINC/UCUM or internal key), value, unit, effective_start/end, source_id, device,
     consent_id, ingested_at. **Aggregate at ingest** for high-frequency types: 5-minute buckets kept 30 days, hourly
     and daily kept for the account lifetime; no per-sample rows. Monthly partitions created by a maintenance job; a
     retention purge job with alerting.
   - `health_sources` (replaces the health half of `user_connections` and merges `user_integrations` — one connection
     model; `wearables-waitlist` unchanged), `token_ref` to KMS-encrypted secret, never the token.
   - Cross-source dedup by category priority (watch > phone; dedicated device > aggregator; member override).
   - **Capacity model required in the Phase 1 plan** (rows/member/day per category, backfill volume, GB at 40%
     connected) and a placement decision (Aurora vs a separate time-series store on AWS). Target architecture
     (cutover runbook Option A, owner decision 2026-09-19): **data on Aurora, sign-in on Supabase Auth permanently**,
     file storage on Supabase Storage until a separate S3 storage migration. The cutover (one-time dump/restore under
     a write freeze) has not happened yet. **Health Hub tables go live in production only on Aurora:** before the cutover
     they exist and are exercised only in 0T; if business needs them in production earlier, a parity gate applies
     (schema created on both sides, partitions attached on Aurora, RLS/policy parity regenerated into the restore scripts,
     per-partition row-count and RLS-isolation reconciliation test) and is added to the cutover checklist.
4. **Feature layer.** `health_features_daily` becomes derived from observations. **All current writers re-routed**:
   `diary-health-extractor-repository.ts`, `orb-tools/health-depth-tools-repository.ts`,
   `voice-tools/health-log-repository.ts`, `routes/integrations-repository.ts` (manual log) and the SQL
   `health_compute_features_daily` become observation writers (`source = diary|voice|manual|…`). **Vitana Index
   continuity:** dual-compute old and new for ≥14 days, compare, then cut over. Personal 30/90-day baselines, pattern
   detection limited to the §2 catalogue, data-quality per feature.
5. **AI layer.** A **new wellness context module** (not an extension of `user-health-context.ts`, which stays for
   non-health commerce context after D12 is removed): compact summary of consented categories only. Recommendation
   engine with data basis, evidence note, pillar, wellness framing; output guard (§2a); feedback loop (offered →
   accepted → done → metric moved) used for ranking; "Why am I seeing this". Claude via Bedrock EU; never used for training.
6. **Consent, security, audit.**
   - `health_consents` (purpose × category × source, versioned text, 11 locales).
   - **Withdrawal semantics:** ingest stops immediately; the member chooses "delete history" (default) or "keep, stop
     using"; on delete, observations of that category are erased and derived features/Index recomputed; in both cases the
     category is excluded from AI context, recommendations and memory extraction; caches invalidated.
     "Delete history" asks for confirmation and is soft-deleted for 7 days (undo possible, data unusable) before hard erasure.
     The exclusion also applies to the general conversational memory extractor: health facts of a withdrawn category
     (memory_facts/memory_items marked `special_category`, VTID-04798) are not extracted and existing ones follow the
     member's keep/delete choice. Because `sensitivity` is binary today, Phase 1 adds a fact-key → health-category
     mapping (or a `health_category` column) with a test that withdrawing one category leaves the others untouched.
     Account erasure inside the 7-day window hard-deletes soft-deleted rows and S3 raw batches immediately.
   - Tokens in KMS; on disconnect tokens nulled and revoked at the vendor.
   - Webhooks verified per vendor spec with timestamp tolerance, then fail closed; DoctorBox webhook disabled until a spec exists.
   - `connector_webhooks_log`: stop storing payloads (hash + metadata only), backfill `user_id`, purge history.
   - `health_access_log` for every non-owner read (partitioned, `memory_audit_log` pattern).
   - Export (FHIR/JSON/CSV); erasure extended to the `health-reports` bucket wherever it lives (Supabase Storage today, S3 after the storage migration), inbox, S3 raw batches and vendor deregistration, with a
     test proving partitioned children are erased.
7. **Outbound.** Member-to-provider grants (org/practitioner, categories, period, expiry, revoke, logged);
   write-back to HealthKit/Health Connect is a later item. A public Hub API is **out of this program** (separate plan later).

## 4. Mobile — aligned with the parallel native-app effort
- No native project exists (D11). This plan does not choose the app framework; the native-app effort owns the apps.
  This plan owns the **Health Sync contract** and the backend.
- **Health Sync contract v1** (Phase 1, frozen before native health work starts): ingest API; device auth (gateway JWT
  obtained by the app's login; refresh token in iOS Keychain / Android Keystore-backed storage; never in web storage);
  data catalogue (HealthKit / Health Connect types → codes/units; backfill 90 days default); incremental sync via anchors
  / change tokens; batching, retry, offline queue; consent-before-OS-permission flow; OS permission revoked → source paused;
  background rules (HealthKit background delivery, Android WorkManager); store compliance pack.
- **Sequencing:** the first store release ships the health sync module (inside a native shell that may still host the
  web UI), so phone data does not wait for a full UI rewrite.
- **Ownership:** native effort = app shell, push, deep links, IAP, health module UI; this plan = API, store, consent,
  feature/AI layers, compliance pack.

## 5. Phases (each = its own sparred plan + VTID(s) before code)
| Phase | Content | Est. | Depends on |
|---|---|---|---|
| 0 Fix live defects | **D12 first** (remove wearable branch of `inferPrimaryCondition`, keep health/medication fields out of commerce, CI purpose-boundary test); D1 revoke `authenticated` writes + token-column read, KMS migration, revoke on disconnect; D2 vendor-correct verification + fail closed; D3 remove fake cards; D4 health switches off by default, wired later to consents, export job; D5 bucket/inbox/webhook-log erasure + purge; D7 stop the false notice/event; D8 member confirmation, audited staff reads, partner_key fix; OAuth callback returns error codes, not raw messages | 4–5 wks | none |
| 0T Test environment | isolated environment shared with the native app program (its gate G1): Aurora test cluster in eu-central-1 behind its own `postgrest-aurora` proxy and a test gateway configuration; **sign-in from a separate free-tier Supabase project used only for test auth (and test file storage), never production auth**; the 0T proxy and gateway trust only that test project's JWT secret/JWKS, with a test proving a production-issued JWT is rejected; prerequisite: the proxy smoke test is runnable (fix the ECS Exec / ssmmessages gap), for write-path and vendor-sandbox tests. Until it exists: recorded-fixture tests only, staging ingest disabled by flag | 1–2 wks | owner |
| 0L Legal (parallel) | intended purpose; DPIA; DPO; Art. 30; processor DPAs (AWS; Supabase permanently for Auth and for Storage until lab files move to S3; Bedrock; aggregator); partner health AVV + `/dpa/sign` (D9); publish Partner Terms v1; counsel review of the §2 pattern catalogue | parallel | counsel |
| 1 Data core | ingest service, store (with capacity model + placement decision), `health_sources` merge, consents + withdrawal, writer re-routing, Index dual-compute + cutover, wellness context module skeleton, Health Sync contract v1 | 6–8 wks | 0, 0T, DPIA draft, Aurora cutover (or the §3.3 parity gate) for production go-live |
| 2 Cloud via aggregator | one EU aggregator, scheduler/webhooks, real Connected Apps screen | 3–4 wks | 1, vendor choice |
| 3 Phone health stores | native health module per contract in the native effort's first release | per native plan | 1, native effort |
| 4 AI recommendations | wellness context, engine, guard + golden tests, feedback loop, explanations | 6–8 wks | 1 |
| 5 Labs & providers | FHIR lab adapter for all partners; upload parser with member confirm; grants, provider view, access history | 6–8 wks | 1, 0L AVV |

## 6. Verification (no production writes — CLAUDE.md absolute rule)
- Unit/integration tests (local Postgres) for every phase; write paths and vendor sandboxes only in the 0T
  environment; staging used for read paths only; no test writes on the shared production database.
- Native module on simulators and test devices with synthetic Apple/Google health data, against the 0T backend.
- AI guard per-locale golden sets in CI; purpose-boundary test in CI (incl. limitations-filter hide-only test);
  erasure test including partitions, soft-deleted rows and S3 raw batches; per-category withdrawal test; voice transcript audit job.

## 7. Success measures
Connected-source rate (40% of active members 6 months after phone launch); data freshness (48h); recommendation
accept/complete/effect rates; retention connected vs not; 0 text guard escapes and voice escapes measured by the
transcript audit (target 0, reviewed weekly); 0 purpose-boundary violations; 0 open DPO incidents.

## 8. Owner decisions
1. Intended-purpose statement direction (wellness, not medical).
2. Confirm the safety-filter carve-out (§2b) and its legal basis; and: may member-**stated** conditions personalise commerce under a separate explicit opt-in, or does no health data ever reach commerce? (Device-derived data never does.)
3. Fund the isolated test environment (0T).
4. Aggregator vendor (EU-hosted).
5. Appoint DPO + counsel; DPIA gates Phase 1 production.
6. Native effort ships the health module in its first release and owns the app shell.
7. CGM stays out of scope until counsel signs off.

<!-- plan:end -->

## Planner responses — round 1
- **F1 [blocker] ACCEPTED.** Added D12; Phase 0 starts with removing the wearable-derived condition branch and keeping health/medication fields out of commerce; the wellness AI context is a new module (§3.5); purpose boundary is a CI test (§2b). Q1 → split confirmed; the stated-condition question is owner decision 2.
- **F2 [blocker] ACCEPTED.** `tenant_id`/`user_id` NOT NULL on every new table, SELECT-only RLS, no authenticated writes, partition erasure test (§3.3, §3.6).
- **F3 [major] ACCEPTED.** D1 now covers grants, token columns, disconnect clearing and vendor revocation, one-time KMS migration (§1 D1, Phase 0).
- **F4 [major] ACCEPTED.** D2 rescoped: vendor-correct verification with sample-signature tests and timestamp tolerance, then fail closed; DoctorBox webhook disabled until a spec exists.
- **F5 [major] ACCEPTED.** Writers listed and re-routed, Index dual-compute ≥14 days, `user_integrations` merged into `health_sources` (Q4: integrations merged; waitlist kept).
- **F6 [major] ACCEPTED.** New Phase 0T with owner decision; fixture-only tests and staging ingest off until it exists (Q5).
- **F7 [major] ACCEPTED.** Aggregate at ingest (5-min/30 d, hourly + daily lifetime), raw batches in S3 not Postgres, partition and purge jobs, capacity model + DB placement required in the Phase 1 plan (Q2: placement decided there with numbers).
- **F8 [major] ACCEPTED.** Withdrawal semantics defined (§3.6); webhook-log payloads stopped, user_id backfilled, purged (Q3: member chooses, default delete).
- **F9 [major] ACCEPTED.** Closed pattern catalogue, no physiological push alerts, CGM out of scope, fixed referral on block, guard fails closed.
- **F10 [minor] ACCEPTED.** L425 reference removed; health switches off by default in Phase 0.
- **F11 [minor] ACCEPTED.** Error codes instead of raw messages in Phase 0.
- **F12 [minor] ACCEPTED.** Public Hub API removed from the program; v1 cloud = one aggregator, existing direct connectors frozen.
- **Q6:** gateway JWT from app login; refresh token in Keychain / Keystore-backed storage (§4).

## Planner responses — round 2
- **F7 acknowledged** by partner: capacity model and placement are a mandatory item of the Phase 1 plan's sparring.
- **N1 [major] ACCEPTED.** §1 D12 lists all importers incl. `limitations-filter.ts`; §2b adds the single hide-only safety-filter carve-out, CI test naming it as the only allowed module plus a remove-only test; legal basis added to owner decision 2.
- **N2 [major] ACCEPTED.** §2a guard split by channel: text pre-check with latency budget and fixed referral; voice by prevention (catalogue-only context, intent rules) plus post-hoc transcript audit; §7 voice target is audit-measured.
- **Q1:** yes — confirmation step and 7-day soft-delete undo window before hard erasure (§3.6).
- **Q2:** applies to the general conversational memory extractor too, via the existing `special_category` marking (§3.6).

## Planner responses — round 3
- **F13 [minor] ACCEPTED.** Phase 1 adds a fact-key → health-category mapping and a per-category withdrawal test (§3.6, §6).
- **F14 [minor] ACCEPTED.** Account erasure overrides the 7-day window for soft-deleted rows and S3 batches; covered by the erasure test (§3.6, §6).

## Verdict
CONVERGED after 3 rounds (partner round-3 verdict). Open items carried forward: F7 (capacity model + DB placement) is a
mandatory item of the Phase 1 plan's own sparring. Owner decisions: plan §8 items 1–7.

## Planner responses — owner correction (2026-10-10)
- Owner: "We use Aurora, not Supabase." 0T is now the AWS-only Aurora test environment shared with the native program's G1; table placement decision is Aurora vs time-series; new tables follow the standard migration path so they move with the cutover; Supabase stays in the processor list only until the cutover completes.

## Planner responses — owner-correction round
- **F15 [major] ACCEPTED.** Health Hub tables go live in production only on Aurora; before the cutover they run only in 0T. An early production need triggers an explicit parity gate (both schemas, attached partitions, RLS parity into the restore scripts, reconciliation test) added to the cutover checklist (§3.3). Q1 answered.
- **F16 [major] ACCEPTED.** Target is data on Aurora + Supabase Auth permanently (+ Supabase Storage until an S3 move). 0T identity = a separate free-tier Supabase project for test auth and test files only; proxy smoke test runnable is a 0T prerequisite; Supabase stays a permanent processor; erasure targets the bucket wherever it lives. Q2 answered.

## Planner responses — closing round
- **F17 [minor] ACCEPTED.** Phase 1 row now depends on the Aurora cutover (or the parity gate) for production go-live.
- **F18 [minor] ACCEPTED.** 0T trusts only the test project's JWT secret/JWKS; a test proves production tokens are rejected.

## Verdict (after owner correction)
CONVERGED (partner closing-round verdict). F7 acknowledged and deferred to the Phase 1 plan.
