# VTID-05164 — acceptance (Health Hub Phase 1 / C1)

Scope: the sparred plan's work package C1 (`plan-sparring.md`, Changes 1–11 and C1's side of shared interfaces S1, S3
mapping, S6 use, S7 keys and the consent-key map). C2 (VTID-05165) and C3 (VTID-05166) are separate VTIDs. Stacked on
#4105 (A2, VTID-05159), which contains A1 (#4102), B1 (#4104) and D10 WP1 (#4100); merges after them.

**What deploys:** gateway code, dark. `POST /api/v1/health/ingest` and `POST /source-state` answer
`409 INGEST_DISABLED` unless `HEALTH_SYNC_INGEST_ENABLED` is exactly `true`, `VITANA_ENV` is not `staging` and A's
store is on (`HEALTH_STORE_ENABLED` + `HEALTH_RAW_BUCKET`); no task definition sets the flag. `GET /contract` and
`GET /status` are readable. **One migration, committed, NOT applied:**
`20261014130000_vtid_05164_health_sync_consent_keys.sql` (Supabase via `RUN-MIGRATION.yml` after Gate 2).

AC-1 Contract v1 is a versioned artifact: zod schemas, error codes and the HealthKit / Health Connect mapping of A's
catalogue codes in `services/health-sync/contract-v1.ts` (codes, units, kinds and ranges imported from A's catalogue);
the generated `contract-v1.schema.json` equals the zod output; its sha256 is locked per version
(`contract-v1.lock.json`), so a schema change without a version bump fails; prose for the native team in
`docs/programs/health-hub/HEALTH-SYNC-CONTRACT-v1.md`; golden request/response fixtures in
`docs/programs/health-hub/health-sync-v1/golden.json`, replayed by Jest.
TEST: test/health-sync/contract.test.ts; test/health-sync/golden.test.ts — outputs/jest-c1.txt

AC-2 Data catalogue v1 is closed: activity (steps, active energy, exercise minutes, distance, workouts), sleep (session
+ stages), heart (HR, resting HR, HRV SDNN/RMSSD), body (weight, body fat %); every code an allowed A code with a UCUM
unit, a range and an OS type; no glucose / CGM / HbA1c, reproductive or clinical code; anything else `UNSUPPORTED_TYPE`.
TEST: test/health-sync/contract.test.ts "data catalogue v1" — outputs/jest-c1.txt

AC-3 Endpoints: `GET /contract` (public, read-only), `POST /` (gate → per-IP limit → `requireAuthWithTenant` →
per-member limit and concurrency → body → schema → adapter), `GET /status` (auth, read-only; source state, consent per
sync category on that source, `ingest_enabled`, `store:{enabled, reason}`, `store_pending`), `POST /source-state`
(same gate). Mounted at `/api/v1/health/ingest`, claimed by `^health` in the atlas, no collision with
`/api/v1/health`.
TEST: test/routes/health-ingest.test.ts — outputs/jest-c1.txt

AC-4 Gate: 409 `INGEST_DISABLED` (`reason: staging|flag_off`) on staging even with the flag set, with the flag unset in
production, and with A's store off — before auth, the rate limiters, the body (an oversize declared body still answers
409) or any port.
TEST: test/routes/health-ingest.test.ts "ingest gate" — outputs/jest-c1.txt

AC-5 Auth and identity: 401 JSON without a token; identity only from the JWT (a body `user_id` / `tenant_id` is
`400 INVALID_BATCH`, strict schema); an AI-delegated token is refused by `delegatedTokenGuard()` before the router.
TEST: test/routes/health-ingest.test.ts "auth and identity"; test/health-sync/contract.test.ts — outputs/jest-c1.txt

AC-6 Body: path-scoped guard before the global JSON parser; the router reads ≤ 512 KB as sent and gunzips with
`maxOutputLength` 4 MB; gzip happy path; a gzip bomb and an oversize body → 413 `BATCH_TOO_LARGE`; another content
type / encoding → 415 `UNSUPPORTED_ENCODING`; bad JSON / bad gzip / schema errors → 400 `INVALID_BATCH` with
`details[{path, code}]` (never the submitted values); a newer major → 400 `UNSUPPORTED_CONTRACT_VERSION` with
`supported_majors`.
TEST: test/routes/health-ingest.test.ts "body, encoding and schema"; index.ts wiring — outputs/jest-c1.txt

AC-7 Rate limits: per-IP 429 `RATE_LIMITED` with `Retry-After` before the JWT verifier is called; per-member limit
after auth keyed by `user_id` (default 120/h); per-member concurrency (default 10).
TEST: test/routes/health-ingest.test.ts "rate limits" — outputs/jest-c1.txt

AC-8 Consent per category × source, fail closed: one read per category present (≤ 4) through A2's
`findActiveHealthConsentId`; unconsented records are dropped before A (A's samples, raw archive and quarantine never
see them) as `CATEGORY_NOT_CONSENTED`; nothing consented and no deletion → 403 `CONSENT_REQUIRED` with `categories` and
nothing created; a consent read error is "not granted"; deletions always pass through and the S8 hook fires.
TEST: test/health-sync/adapter.test.ts "consent per category" — outputs/jest-c1.txt

AC-9 Idempotency through A: same batch → `replay:true`, nothing written twice; resend in a new batch → `duplicate`;
same `record_id`, new value → `updated`; same `batch_id`, new content → 409 `BATCH_ID_REUSED`.
TEST: test/health-sync/adapter.test.ts "idempotency through A (S3)"; golden.test.ts — outputs/jest-c1.txt

AC-10 S3 mapping table exactly as the shared interfaces state (batch and per-record), `STORE_PENDING` when A's or B's
tables are absent, `SOURCE_PAUSED` for a paused or disconnected source, never throws.
TEST: test/health-sync/adapter.test.ts "per-record codes from A", "store and source states" — outputs/jest-c1.txt

AC-11 S7: D10 keys `sync_activity`, `sync_sleep`, `sync_heart`, `sync_body` (`health_source`, `ingestion:<category>`,
per resource) and `self_logged_health` (`health_category`, `ingestion:self_logged`, one consent) in the union, the
static map and the migration seed; `HEALTH_SYNC_SOURCE_KINDS`; `granted_via: native_health_sync`; the grant route
accepts `apple_health`, `health_connect` and aggregator connectors (only) for `sync_*`; A2's consent-key map filled
(phone_store/aggregator → `sync_<category>`, diary/voice/manual → `self_logged_health`, labs/habits on phone stores stay
keyless). The VTID-05092 suites pass; the one seed-equality assertion now compares the 05092 seed with the map's 05092
keys (the 05164 seed has its own assertion).
TEST: test/routes/health-consent-sync.test.ts; test/health-store/store-ops.test.ts "S7 consent-key map"; test/health-store/contract.test.ts; test/migrations/vtid-05164-health-sync-consent-migration.test.ts; test/consent, test/routes/health-consent.test.ts, test/migrations/vtid-05092-health-consent-migration.test.ts, test/partner-health-consent.test.ts — outputs/jest-c1.txt

AC-12 Connector ids `apple_health` / `health_connect`: code registry (`category: 'health_store'`, `sdk_bridge`), D10
grant-route resources, `connector_registry` rows in the migration (category CHECK widened as a superset).
TEST: test/migrations/vtid-05164-health-sync-consent-migration.test.ts; scripts/ci/sql-tests/run-health-sync-consent-test.sh — outputs/sql-health-sync-consent.txt

AC-13 Migration: one transaction, refuses to apply without VTID-05092 (and leaves nothing behind), additive, idempotent;
five catalogue rows (`processing_active`, enforcement points listed and checked by a guard test); `granted_via` CHECK =
05092 values + `native_health_sync` and `fn_set_health_consent()` with the same body and list (service_role only);
VTID-05156's revoke of `health_ingest_wearable_samples(jsonb)` asserted in place; no consent row inserted.
TEST: scripts/ci/sql-tests/run-health-sync-consent-test.sh (CI SQL-HEALTH-SYNC-CONSENT.yml) — outputs/sql-health-sync-consent.txt; test/migrations/vtid-05164-health-sync-consent-migration.test.ts

AC-14 Legacy path: `POST /api/v1/health/wearables/ingest` answers 410 `{ok:false, error:'SUPERSEDED',
use:'/api/v1/health/ingest'}` before any auth or database call (the revoke itself is VTID-05156's).
TEST: test/routes/health.test.ts — outputs/jest-c1.txt

AC-15 OASIS: `health.sync.batch.processed`, `health.sync.batch.rejected`, `health.sync.source.paused`,
`health.sync.source.resumed` declared in `CicdEventType`; payloads carry batch id, source kind, category names, counts
and codes — never a value or a record id; an emit failure is logged and never fails the batch.
TEST: test/health-sync/adapter.test.ts "OASIS"; test/routes/health-ingest.test.ts "source-state"; `tsc` — outputs/jest-c1.txt, outputs/tsc.txt

AC-16 Aggregator: `AggregatorBatchAdapter` interface + fixture adapter (tests only); the adapter's batch is validated
by the same schema; an aggregator source is looked up, never created by a delivery.
TEST: test/health-sync/adapter.test.ts "aggregator channel" — outputs/jest-c1.txt

AC-17 No regressions: full gateway Jest (same 19 suites fail as on the base commit, all for the local
`libphonenumber-js` / `@aws-sdk/client-pinpoint-sms-voice-v2` gap), `tsc` (only those two missing modules).
TEST: npx jest (full); npx tsc --noEmit -p . — outputs/jest-full-summary.txt, outputs/tsc.txt

## Decisions taken (inside the approved plan)

1. **Body parsing:** `express.raw({inflate:false})` rejects every `Content-Encoding` with 415 in body-parser, so it
   cannot carry gzip. The path-scoped middleware in `index.ts` reads nothing and only keeps the global JSON parser off
   `POST /`; the router reads the raw bytes itself (512 KB as sent, gunzip bounded at 4 MB) **after** the gate, the
   per-IP limit and auth, and answers 413 directly (no generic error handler involved).
2. **Store state in the gate:** the ingest gate also requires A's store to be on (`getHealthStoreStatus`), so a
   store-off gateway answers 409 `INGEST_DISABLED` (`reason:'flag_off'`) before anything is read — the same answer the
   S3 mapping gives for `STORE_DISABLED`.
3. **Consent before the source:** the adapter checks consent before resolving / creating the phone-store source, so an
   unconsented batch creates nothing (the plan lists source before consent; no behaviour the plan requires changes).
4. **Disconnected = paused on the wire:** a `disconnected` source answers 409 `SOURCE_PAUSED` (not retryable) instead of
   S3's `SOURCE_NOT_CONNECTED` → 503 (retryable), so the app stops instead of retrying forever. `active` on
   `/source-state` resumes only a source paused for the OS permission; a source the member disconnected stays
   disconnected.
5. **`not_found` deletions** count as `deleted` in the response (a deletion is idempotent).
6. **Per-record `STORE_UNAVAILABLE`** carries `retryable:true` (the S3 mapping says retryable); the app re-sends that
   record in a new batch, because a replay of the same `batch_id` returns the stored outcome.
7. **Sleep stages:** the record schema adds an optional `stages` array (sleep_session only, ≤ 200), carried to A as the
   sample `detail`; the plan's catalogue names "sleep session and stages" but its record field list had no place for
   them. `source.device` becomes the sample's `device` label.
8. **Platform check:** `apple_health` must come with `ios`, `health_connect` with `android` (400 otherwise).
9. **Response `consent`** lists only the categories present in the batch (the categories actually read).
10. **OASIS:** `processed` / `rejected` are emitted by the adapter for outcomes after the schema check (403, 409,
    429 from A's quota, 503 and 200); transport-level refusals (401, 400, 409 gate, 413, 415, IP/member 429) emit
    nothing, so a probe cannot flood OASIS.
11. **`connector_registry` rows** are seeded `enabled = FALSE` (the frozen-connector pattern): nothing lists them to
    members until the native module ships; the FK and the grant route do not depend on `enabled`.
12. **`fn_set_health_consent`** is re-created with the VTID-05092 body unchanged except the `granted_via` list, because
    the function checks that list in its body; a Jest test proves the bodies are equal apart from that value.
13. **D10 seed-equality test:** `test/consent/health-consent.test.ts` compared the whole static map with the 05092 seed;
    it now compares the 05092 seed with the map's 05092 keys, and the new migration test compares the 05164 seed with
    the five new keys. Every other 05092 test is unchanged.
14. **A2 tests touched (the consent-key map edit's own consequence):** `store-ops.test.ts` asserted the `null`
    entries and `contract.test.ts` used a phone-store steps sample as the "no key" example; both now assert the filled
    map, the keyless example uses a habits code on a phone store, and a new case proves the per-source `sync_activity`
    consent.
15. **Aurora parity scripts:** unchanged — C1 creates no table, grant or policy; the new rows and CHECK values reach
    Aurora with the data copy, and `fn_set_health_consent`'s ACL is restated in the migration.
16. **Enforcement-point guard:** `HEALTH_CONSENT_ENFORCEMENT_POINTS` (health-consent.ts) lists the enforcement files of
    every `processing_active` key; the migration test fails if a key has none or a file does not check it.
17. **Status route query** uses `source_kind` + `install_id`; a malformed query is 400 `INVALID_REQUEST`.

## Not in C1

- `/status` returns no per-record history; the native module keeps its own anchors (plan Change 5).
- The ingest flag stays unset everywhere; turning it on is its own Gate 2 (plan Rollout 6).
- C2 (wellness context) and C3 (consent copy) are separate VTIDs.

## Route mount evidence

ROUTE_MOUNT: `services/gateway/src/index.ts` — `app.use('/api/v1/health/ingest', healthIngestModule.healthIngestBodyGuard())` before `app.use(express.json({ limit: '2mb' }))`, and `mountRouterSync(app, '/api/v1/health/ingest', healthIngestRouter, { owner: 'health-ingest' })` after `delegatedTokenGuard()` and the `/api/v1/health` router (no catch-all there). Router `services/gateway/src/routes/health-ingest.ts`. Claimed by the `health` domain in `orb/developer/domain-atlas.ts` (`/^health/`).
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/health/ingest/contract
CURL_PROOF: read-only, after the staging deploy: `GET /api/v1/health/ingest/contract` → `200 application/json` with `contract_version:"1.0"`; `GET /api/v1/health/ingest/status?...` with no Authorization header → `401 application/json` (not an HTML 404); `GET /api/v1/health/` still `200 application/json`. No POST is ever sent to staging.
TEST: npx jest test/routes/health-ingest.test.ts

OASIS_PROOF: four new event types in `services/gateway/src/types/cicd.ts`, `vtid: 'VTID-05164'`, `source: 'health-sync'`, actor = the member, `surface: 'api'`: `health.sync.batch.processed` / `health.sync.batch.rejected` (test/health-sync/adapter.test.ts "OASIS" asserts the payload has no value and no record id), `health.sync.source.paused` / `health.sync.source.resumed` (test/routes/health-ingest.test.ts "source-state"). Nothing is emitted while the gate is closed, i.e. never on staging.
