# VTID-05161 — acceptance (Health Hub Phase 1 / B1)

Scope: the sparred plan's work package B1 (`plan-sparring.md`, Changes 1–5, shared interface S6). B2 (VTID-05162) and
B3 (VTID-05163) are separate VTIDs. Stacked on A1 (VTID-05158, PR #4102) and merges after it.

**What deploys:** gateway code, dark. `HEALTH_SOURCES_DUAL_WRITE` and `HEALTH_SOURCES_READ` are off by default and
forced off on staging, and `health_sources` does not exist on Supabase. So every touched route behaves exactly as
before. **Migrations:** `20261014100200_*` is Aurora only (0T, then production after the cutover; never Supabase).
`20261014100300_*` (the `user_integrations` revoke) applies to Supabase through `RUN-MIGRATION.yml` after Gate 2.

AC-1 `health_sources` exists with the plan's columns. `connector_id` is nullable with an FK to `connector_registry(id)`.
`token_ref` is a `user_connections:<uuid>` pointer (CHECK) and the table has no token column. There is no FK to
`auth.users`. The identity key is unique on `(tenant, user, kind, coalesce(connector_id,''), coalesce(provider_user_id,''))`,
the legacy ids are unique, and kind/connector CHECKs apply. The migration is idempotent (applied twice).
TEST: scripts/ci/sql-tests/run-health-sources-test.sh §1–§4; test/migrations/vtid-05161-health-sources-migration.test.ts — outputs/sql-health-sources.txt, outputs/jest.txt

AC-2 The backfill covers only `user_connections` rows with `category IN ('wearable','aggregator')` (social rows are
excluded) and maps status as active → connected, disconnected_at → disconnected, else pending. It also backfills
`user_integrations`: `manual-entry` → manual, a registered wearable/aggregator id → that connector. The tenant is the
primary `user_tenants` row. Unmapped and tenant-less rows are skipped and counted (NOTICE). On a conflict the older
legacy row wins. Uses `ON CONFLICT DO NOTHING`.
TEST: run-health-sources-test.sh §1 (mutations: dropping the category filter, or the primary-first tenant order, turns it red) — outputs/sql-health-sources.txt

AC-3 Placement guard: refuses a Supabase-shaped database and leaves nothing behind. Applies with
`vitana.health_store_target = 'aurora'`. `health_sources` is in `aurora_only_tables` (VTID + reason), and a node test
checks that every table behind the placement guard is listed.
TEST: run-health-sources-test.sh step 2; node --test scripts/ci/check-migration-drift.test.cjs — outputs/sql-health-sources.txt, outputs/node-tests.txt

AC-4 RLS: a member reads only their own rows and cannot INSERT, UPDATE or DELETE. `anon` reads nothing. There is
exactly one SELECT policy. `health_sources_reconcile_counts()` is STABLE SECURITY DEFINER, `service_role` only, and
returns counts with no ids.
TEST: run-health-sources-test.sh §5–§6 (mutation: removing the REVOKE turns it red)

AC-5 `erase_user_data()` finds `health_sources` through its catalogue scan (dry run lists it). A real run empties it
for that member only. The table is not in `erasure_registry`.
TEST: run-health-sources-test.sh §7

AC-6 Change 1c: after `20261014100300_*`, a member can no longer INSERT, UPDATE or DELETE `user_integrations`, still
reads own rows, and `service_role` still writes. The FOR ALL policy is gone (self-check by effect). The migration is
idempotent and applies on a Supabase-shaped database. The Aurora parity scripts carry the same end state, and every
`health_sources` statement in them is guarded with `to_regclass`.
TEST: run-health-sources-test.sh §8 and 2b (mutation: keeping `user_integrations_owner_all` fails the self-check); vtid-05161-health-sources-migration.test.ts

AC-7 S6: `resolveHealthSource` behaves as follows.
- `create:true` is idempotent for manual, voice and diary, and creates phone stores.
- It never creates device_cloud, aggregator or partner sources.
- A lookup by `source_id` must belong to the identity.
- C's phone-store alias `{kind:'phone_store', install_id, platform}` resolves to the same row as the canonical form.
- An unknown platform or an empty install_id → SOURCE_NOT_CONNECTED, and nothing is created.
- A phone-store create → STORE_UNAVAILABLE until `apple_health`/`health_connect` exist in `connector_registry` (C1).
- STORE_PENDING while the table is missing. The function never throws.

`setHealthSourceState` updates only own sources, validates the status and `reason_code`, and maps C's
`os_permission_revoked`/`active`. `listHealthSources` returns own sources.
TEST: test/vtid-05161-health-sources.test.ts "S6 …" (9 tests)

AC-8 Change 3, dual-write. With the flag off or on staging, nothing is read or written. With the flag on, each legacy
write re-reads the legacy row and upserts the matching source by legacy id, using the backfill mapping. The write
sites are:
- wearables connect, callback and disconnect
- the webhook auth.completed / auth.revoked topics
- integrations connect and disconnect
- the manual-entry upserts of the manual-log route, the voice log tool and the ORB health tools

A failure gets a code. It is counted, logged, and emitted as OASIS `health.sources.dual_write_failed` (site + code, no
member id; rate-limited). The legacy response is identical.
TEST: test/vtid-05161-health-sources.test.ts "Change 3 …" (5 tests)

AC-9 Change 4, read switch. With `HEALTH_SOURCES_READ` on, `GET /api/v1/integrations`, `/wearables/connections` and
`/wearables/providers` return byte-identical JSON over the same fixture. Connection state demonstrably comes from
`health_sources`. A missing table or an unlinked legacy row falls back to the legacy answer (logged).
TEST: test/vtid-05161-health-sources.test.ts "Change 4 …" (4 tests)

AC-10 Change 5, reconciler. It runs once per UTC date, only from the first batch of the nightly daily-recompute call,
only with a B1 flag on, and never on staging. It emits OASIS `health.sources.reconcile` with counts only. A missing
function → STORE_PENDING and no event. It never changes the scheduler response. The SQL counts detect unlinked,
unmapped, tenant-less, status-mismatched and orphaned rows.
TEST: test/vtid-05161-health-sources.test.ts "Change 5 …"; run-health-sources-test.sh §5

AC-11 Existing guards stay green:
- every Jest suite that touches a changed file
- every migration-scanning suite
- `test:roles` (atlas drift guard; no new route file)
- `test:operator` and `test:support`
- VTID-04968 delegation guard and VTID-05025 commerce boundary
- the A1 SQL suites
- every `scripts/**` node test
- `tsc` (no new errors)
TEST: outputs/jest.txt (133 suites, 2,796 tests), outputs/sql-a1-suites-unchanged.txt, outputs/node-tests.txt, outputs/tsc.txt

AC-12 `DATABASE_SCHEMA.md` documents `health_sources` as "committed, NOT applied — Aurora only" and the revoke as
applied to Supabase via `RUN-MIGRATION.yml` after Gate 2. `docs/programs/health-hub/STATUS.md` lists B1–B3.
TEST: review of DATABASE_SCHEMA.md (change-log row + "Health Hub connection model" section)

## Staging

B1 deploys gateway code, so `staging-tests.json` has read-only GETs:
- the two member routes reject an invalid bearer with 401 JSON;
- `/wearables/providers` answers 200 `ok:true`.

It also lists the Jest suites with the reason. Every write path is Jest/SQL only (rule 48). Staging runs the legacy
path by construction (flags forced off, table absent).

## Decisions taken (inside the approved plan)

1. Two migrations, not one. `health_sources` is Aurora-only (placement guard). The `user_integrations` revoke targets
   Supabase (Gate 1 "yes"), so it is a separate file with no guard.
2. `user_integrations` rows whose `integration_id` is neither `manual-entry` nor a wearable/aggregator
   `connector_registry` id are not backfilled. Examples are `whoop` and `myfitnesspal`; these were "connected" without
   OAuth and have no data path. They are counted (NOTICE) and reported by the reconciler as `integrations_unmapped`.
   They are never guessed onto a NULL connector, which would also collide on the identity key.
3. When several legacy rows map to one identity key, the oldest wins and the rest are reported as unlinked. This
   happens with two `user_connections` rows that both have a NULL `provider_user_id`, which legacy uniqueness allows.
4. Dual-write re-reads the legacy row and upserts by legacy id with the backfill mapping, instead of re-stating each
   write. A mirror can then never disagree with the legacy model, and replays are harmless. The calls are scheduled
   after the legacy write and not awaited, so they add no latency.
5. The plan's "four manual-entry upserts" are three in the code. W-diary writes no `user_integrations` row (verified by
   grep), so mirrors sit at the three real sites. They mirror the shared `manual-entry` row as kind `manual`. The lazy
   per-writer `voice`/`diary` sources are B2's `recordToHealthStore`.
6. The read switch takes connection state (status/is_active, connected_at, disconnected_at, last_sync_at) from
   `health_sources`. Display fields the model does not carry come from the linked legacy row: display name, provider
   username, free-text `last_error` and metadata. Any unlinked row falls back to the legacy answer, so the shape
   stays byte-identical.
7. The reconciler runs from the existing nightly `POST /api/v1/scheduler/daily-recompute` (first batch, once per UTC
   date per task, fire-and-forget). There is no new route or EventBridge rule. The counts come from one SQL function
   (`health_sources_reconcile_counts()`).
8. `setHealthSourceState` answers `INVALID_INPUT` for a bad status or `reason_code` (S6 leaves `{ok:false, code}` open).
   `resolveHealthSource` keeps the three S6 codes; invalid input there is `SOURCE_NOT_CONNECTED`.
9. `create:true` creates only the kinds S6 names (manual, voice, diary, phone_store). Device clouds, aggregators and
   partners come from their connection flows.
10. `health_sources` was not added to the VTID-05025 `HEALTH_TABLES` list. It holds connection metadata, not health
    values, and the plan adds tables there in B2.

## OASIS

OASIS_PROOF: two new event types declared in `services/gateway/src/types/cicd.ts` — `health.sources.dual_write_failed` (payload `{site, code, suppressed_since_last}`, no member id; asserted in test/vtid-05161-health-sources.test.ts "a failure is counted, logged and emitted with codes only") and `health.sources.reconcile` (payload counts only; asserted in "Change 5 — reconciler"). Both are emitted only with a B1 flag on, never on staging.
