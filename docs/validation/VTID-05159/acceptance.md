# VTID-05159 — acceptance (Health Hub Phase 1 / A2)

Scope: the sparred plan's work package A2 (`plan-sparring.md`, Changes 5–11 and the A2 side of shared interfaces
S2–S5, S7's lookup and consent-key map, S8–S10). A1 (VTID-05158) and A3 (VTID-05160) are separate VTIDs. Stacked on
#4102 (A1), #4104 (B1, VTID-05161, S6) and #4100 (D10 WP1, VTID-05092, `hasHealthConsent`); merges after them.

**What deploys:** gateway code, dark. `HEALTH_STORE_ENABLED` is off by default, forced off when `VITANA_ENV=staging`,
and needs `HEALTH_RAW_BUCKET` too; no task definition sets either in this package. The store's tables exist only on
Aurora (A1). **No migration in A2.** The infra scripts are dry-run by default; `--apply` is owner-run at go-live.

AC-1 S2 catalogue: `catalogue.ts` equals the A1 `health_codes` seed field by field (the test parses the migration);
keys and ids unique; every code has a unit, kind, category, range and daily rule; no glucose/CGM/HbA1c code;
`categoryOf`, `kindOf`, `dailyRuleOf`, `sourceRankOf` exported.
TEST: test/health-store/catalogue.test.ts — outputs/jest-health-store.txt

AC-2 S5 `HEALTH_STORE_TABLES` names the six member-data tables; no gateway module outside `services/health-store/**`
references them; the VTID-05025 commerce boundary bans them and any import of `services/health-store/*`.
TEST: test/health-store/catalogue.test.ts; test/vtid-05025-commerce-health-boundary.test.ts — outputs/jest-health-store.txt

AC-3 Dark flag: off by default, forced off on staging, off without `HEALTH_RAW_BUCKET`; off → `writeHealthSamples` and
every reader answer `STORE_DISABLED` without reading anything; `/maintenance` and `/reprocess` answer
`404 {error:'HEALTH_STORE_DISABLED'}` without touching the store; `GET /store-status` (member JWT) says why.
TEST: test/health-store/store-ops.test.ts "dark flag"; contract.test.ts "disabled"; test/routes/health-store-internal.test.ts — outputs/jest-health-store.txt

AC-4 S3 `writeHealthSamples` never throws: a throwing repository (each method), S3 client, consent read, source
lookup, emitter or hook gives a result; garbage input and > 5,000 items give `INVALID_INPUT`; an unknown or another
member's source gives `SOURCE_NOT_CONNECTED`.
TEST: test/health-store/ingest.test.ts "never throws"; contract.test.ts — outputs/jest-health-store.txt

AC-5 Order and round trips: flag → input → source (S6) → quota → batch idempotency → consent (one read per distinct
consent key/resource, at most one per category present) → one S3 put of the consented subset → validation and
quarantine → one RPC per ≤ 2,000-item chunk → batch row → change hook. S3 failure → `STORE_UNAVAILABLE`, no RPC, no
batch row; store not applied → `STORE_PENDING` before anything is archived.
TEST: test/health-store/ingest.test.ts "round trips and order" — outputs/jest-health-store.txt

AC-6 Consent (S7) is inside, per sample category, fail closed: no consent / a failing read → `skipped_no_consent`
(`CONSENT_REQUIRED`), never archived, quarantined or stored; a (source kind, category) whose D10 key does not exist yet
(`sync_*`, `self_logged_health` ship as `null` for C1 to fill) → `CONSENT_CATEGORY_MISSING`; deletions are processed
without consent; the consent id is stored on every row and on the batch row. `findActiveHealthConsentId` is added
next to `hasHealthConsent` with the same query, returning the row id or null (fail closed).
TEST: test/health-store/contract.test.ts; store-ops.test.ts "S7 consent-key map"; test/routes/health-store-internal.test.ts "S7 findActiveHealthConsentId" — outputs/jest-health-store.txt

AC-7 Idempotency: same `batch_id` + same normalised content → stored results with `replay:true`, nothing written; same
id + new content → `BATCH_ID_REUSED`; replace mode: same key + same content → `duplicate`, new content → `updated`.
TEST: test/health-store/contract.test.ts (both harnesses) — outputs/jest-health-store.txt

AC-8 Validation: `UNIT_MISMATCH`, `IMPLAUSIBLE`, `MISALIGNED_BUCKET`, `FUTURE`, `TOO_OLD`, `UNKNOWN_CODE`,
`CATEGORY_NOT_ALLOWED` are quarantined with the reason and no value; a malformed item is `invalid` (`INVALID_ITEM`) and
not quarantined; valid items in the same batch are stored; series older than 30 days go to the hourly tier; daily
attribution follows the batch time zone (Europe/Berlin DST day).
TEST: test/health-store/ingest.test.ts "validation and quarantine"; contract.test.ts — outputs/jest-health-store.txt

AC-9 Partition routing: a 23514 / "no partition … found for row" → `health_store_ensure_partitions(now)` once, the
chunk retried once; still failing → that chunk's samples are `store_unavailable`, a `health.store.partition_missing`
log line and OASIS event, other chunks stored, no throw.
TEST: test/health-store/ingest.test.ts "partition routing" — outputs/jest-health-store.txt

AC-10 Quota: ≤ 500 batches and ≤ 50,000 items per member per UTC day (≤ 250,000 in the 7 days after a source's first
batch) → `QUOTA_EXCEEDED` + one `health.store.quota.exceeded` (ids and counts, no member id).
TEST: test/health-store/ingest.test.ts "quota" — outputs/jest-health-store.txt

AC-11 S4 readers: mandatory `purpose` (`PURPOSE_REQUIRED`, repository not called); `ai_context` requires
`ai_health_analysis` (`consent_required`, repository not called); suppressed rows never returned; `value` from the
best-ranked source by the code's daily rule, every source listed; `readSeries5m`, `readHourly`, `readRecords`.
TEST: test/health-store/store-ops.test.ts "S4 readers"; contract.test.ts — outputs/jest-health-store.txt

AC-12 S8/S9: `registerHealthStoreChangeHook`; `suppressHealthData` / `unsuppressHealthData` call the hooks after the
commit, a throwing hook never fails the primitive; a deleting write fires the hook with the affected dates;
suppression also deletes the source's raw batches; withdrawal works with the flag off; suppressed rows are purged after
7 days.
TEST: test/health-store/store-ops.test.ts "S8 change hook and S9 withdrawal"; contract.test.ts — outputs/jest-health-store.txt

AC-13 S10 fake: the same contract suite runs against `testing/fake-health-store.ts` and against the real module entry
points with mocks (in-memory twin of the A1 SQL functions, fake S3 client).
TEST: test/health-store/contract.test.ts (15 cases × 2 harnesses) — outputs/jest-health-store.txt

AC-14 Internal routes (`/api/v1/health/internal`): `/maintenance` rejects without `X-Gateway-Internal` (401), with a
wrong one (403), fails closed without a configured token (503), runs ensure → purge (+ partition check); `/reprocess`
(service token or exafy_admin) re-checks the CURRENT consent (revoked → nothing written); `/erase-raw` deletes only the
member's prefix (or one source), lists again and reports `{deleted, residual}`; `GET /store-status` needs a member
JWT. Errors are codes, never database messages.
TEST: test/routes/health-store-internal.test.ts — outputs/jest-health-store.txt

AC-15 Raw batches: key `u/<user>/<source>/<yyyy>/<mm>/<dd>/<batch>.json.gz`, gzip JSON, SSE-KMS; erasure pages through
listings; never a bucket-wide prefix.
TEST: test/routes/health-store-internal.test.ts "raw-batch store over S3" — outputs/jest-health-store.txt

AC-16 Maintenance: ensure → purge, partition check + capacity snapshot on the 02:xx UTC run, log lines for the
alarms, OASIS `health.store.maintenance.completed|failed`; never throws.
TEST: test/health-store/store-ops.test.ts "maintenance run" — outputs/jest-health-store.txt

AC-17 Infra scripts, dry-run by default and calling no AWS API in a dry run: `setup-health-raw-bucket.sh` (CMK +
alias, Block Public Access, SSE-KMS + bucket key, versioning off, 30-day expiry, 1-day multipart abort, TLS-only and
SSE-KMS-only policy, task-role grants; refuses staging); `setup-health-store-alarms.sh` (no successful maintenance for
4 h, partition check, partition-missing writes, three placement triggers → `vitana-alarms-prod`; the write-I/O trigger
is a documented manual check); `setup-eventbridge-cron-migration.sh` gains `gateway-health-store-maintenance`
(`23 * * * *` UTC, internal token) only when `HEALTH_STORE_GATEWAY_URL` names a store-enabled gateway (staging refused).
TEST: test/health-store/infra-scripts.test.ts — outputs/jest-health-store.txt

AC-18 OASIS topics declared in `CicdEventType`: `health.store.source.first_data`, `health.store.batch.quarantined`,
`health.store.quota.exceeded`, `health.store.maintenance.completed|failed`, `health.store.partition_missing`; payloads
carry ids and counts, never values. Per-batch success is telemetry (log line + batch row), not OASIS.
TEST: test/health-store/ingest.test.ts; store-ops.test.ts; `tsc` — outputs/jest-health-store.txt, outputs/tsc.txt

AC-19 No regressions: the full gateway Jest suite, `tsc`, VTID-05161 and VTID-05025 suites.
TEST: npx jest (full); npx tsc --noEmit -p . — outputs/jest-full-summary.txt, outputs/tsc.txt

## Decisions taken (inside the approved plan)

1. `readDailyObservations` takes an optional `tz` (default UTC) for attributing **record** codes to a local date;
   series codes use the daily tier, attributed at ingest with the batch's tz. Additive and optional (S3 already has an
   optional `tz`).
2. The readers' error union adds `INVALID_INPUT` for a malformed range, code list or time zone (S4 names no code for it).
3. The SQL status `suppressed` (a key under withdrawal) maps to `skipped_no_consent` with code `WITHDRAWN`: S3 has no
   `suppressed` status, and a resend of withdrawn data must never resurrect it.
4. An unknown code is quarantined (`UNKNOWN_CODE`, key only, no value) **before** the consent gate — it has no category,
   so no consent can cover it — and is never archived.
5. Store writes are grouped into chunks per (consent id, time zone); the batch row's `consent_id` is the single consent
   id when there is one, otherwise null with every id in `results.consent_ids`.
6. A `series_sum` interval is stored as `n=1, sum=min=max=value`, so daily `sample_count` counts intervals.
7. `/erase-raw` (and the raw erase inside `suppressHealthData`) run whenever a raw bucket is configured outside staging,
   even with `HEALTH_STORE_ENABLED` off: a rollback unsets the flag but leaves up to 30 days of raw batches, and
   erasure must still reach them. With no bucket (or on staging) it answers the plan's 404 `HEALTH_STORE_DISABLED`,
   which A3 counts as nothing to erase. Errs toward erasure.
8. Auth runs before the flag check on every internal route, so an unauthenticated caller cannot learn the flag state.
9. A `disconnected` source refuses samples (`SOURCE_NOT_CONNECTED`) but still processes deletions; `paused`, `error`
   and `pending` sources are left to the consent gate.
10. Quota grace and `first_data` use the retained (30-day) batch rows; a source silent for more than 30 days counts as
    new again (approximation, documented).
11. A `partner` source's consent resource is its `connector_id`; without one the sample is `CONSENT_REQUIRED`.
12. Source ranks: device_cloud 1, phone_store 2, aggregator 3, partner 4, manual 5, diary 6, voice 7 (smaller wins).
13. `health_store_ensure_partitions` runs at most once per `writeHealthSamples` call.
14. If the ingest function is missing on the first chunk (`STORE_PENDING`), the raw object just written is deleted again.
15. The partition check and a capacity snapshot (5-minute tier planner row estimate; connected device-type sources from
    B1's `health_sources` as the connected-members upper bound) run on the 02:xx UTC maintenance run, or when the body
    asks `{partition_check:true}`. The fourth placement trigger (health tables > 40 % of cluster write I/O) has no
    per-table metric and is a documented weekly Performance Insights check in the alarms script.
16. The EventBridge job is added only when `HEALTH_STORE_GATEWAY_URL` is set (the default run's job list is unchanged);
    a non-production gateway must name its token secret.
17. Change hooks fire in a microtask after the commit and are not awaited.
18. The raw archive also carries the call's deletions (record ids and codes only) so a reprocess replays them; a
    reprocess uses a new batch id.
19. `DATABASE_SCHEMA.md` (A1 already documents the `health.store.*` namespace) and `STATUS.md` are outside A2's file
    list and are not touched.

## Route mount evidence

ROUTE_MOUNT: `services/gateway/src/index.ts` — `mountRouterSync(app, '/api/v1/health/internal', healthStoreInternalRouter, { owner: 'health-store-internal' })`, right after the `/api/v1/health` router (which has no catch-all, so `/internal/*` falls through to this router); router `services/gateway/src/routes/health-store-internal.ts` (`GET /store-status` requireAuthWithTenant, `POST /maintenance` X-Gateway-Internal, `POST /reprocess` and `POST /erase-raw` requireServiceOrAdmin). Claimed by the `health` domain in `orb/developer/domain-atlas.ts` (`/^health/`).
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/health/internal/store-status
CURL_PROOF: read-only, after the staging deploy: `curl -s -o /dev/null -w '%{http_code} %{content_type}' https://preview-aws-gateway.vitanaland.com/api/v1/health/internal/store-status` with NO Authorization header must answer `401 application/json` (not an HTML 404); `GET /api/v1/health/` still answers `200 application/json`. No POST is ever sent to staging (a write would reach the production Supabase project); the store is forced off there, so a signed-in member would read `{enabled:false, reason:"staging"}` (proven in Jest, test/routes/health-store-internal.test.ts).
TEST: npx jest test/routes/health-store-internal.test.ts

OASIS_PROOF: six new event types in `services/gateway/src/types/cicd.ts`, all `vtid: 'VTID-05159'`, `source: 'health-store'`, `actor_role: 'system'`, payloads with ids and counts only (never member health values, never a member id): `health.store.source.first_data` and `health.store.batch.quarantined` (asserted in test/health-store/ingest.test.ts "first data …" and "each reason is quarantined …"), `health.store.quota.exceeded` ("the 501st batch of the day …", asserts the payload carries no member id), `health.store.partition_missing` ("still failing -> …" and store-ops.test.ts "the 02:xx UTC run …"), `health.store.maintenance.completed|failed` (store-ops.test.ts "maintenance run"). An emit failure is logged and never fails the caller ("a throwing … emitter gives a result"). Nothing is emitted while the store is off, i.e. never on staging.
