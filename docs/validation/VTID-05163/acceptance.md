# VTID-05163 — acceptance (Health Hub Phase 1 / B3)

Scope: the sparred plan's work package B3 (`plan-sparring.md`, Changes 10–14; Tests "B3"; Staging verification "B3").
B1 (VTID-05161) and B2 (VTID-05162) are separate VTIDs. Stacked on B2 (VTID-05162, PR #4109, which sits on A2 #4105,
B1 #4104, D10 WP1 #4100 and main). C1 (#4107, the `sync_*` / `self_logged_health` consent keys) is NOT in this base and
nothing here depends on its files; until C1 lands, the S7 key map answers `null` for self-logged sources, which the
dual-compute classifies as `consent_withheld`.

**What deploys:** gateway code, dark. `VITANA_INDEX_DUAL_COMPUTE_ENABLED` and `HEALTH_FEATURES_SOURCE` are unset
everywhere and forced off when `VITANA_ENV=staging`; the switch additionally needs `HEALTH_FEATURES_CUTOVER_DATE` and the
writer's own B2 dual-write flag. While the switch is off, every writer, the D6a bridge, W-sql and the daily recompute
behave exactly as on the B2 base, so the Index members see cannot change (AC-10). **Migration:**
`20261014100800_vtid_05163_index_dual_compute.sql` is Aurora only (0T, then production after the cutover; never
Supabase). Nothing to apply at this change's Gate 2. The rollback data fix-up
`data-fixups/20261014100900_vtid_05163_rollback_health_features.sql` is committed for review and is **never applied by a
deploy**: only the owner runs it (Change 14b).

AC-1 Change 10, the read-only projection. `vitana_index_project_for_user(p_user_id, p_device_from, p_self_from)` is the
live `health_compute_vitana_index_for_user` arithmetic without the INSERT; its feature rows come from one set
(`vitana_index_projected_feature_rows`) built from `health_features_daily` and `health_features_daily_v2`: the seven
device keys from v2 for `date >= p_device_from`, the coded self-logged keys (`meal_log`, `water_intake`, `mood_entry`,
`meditation_minutes`) from v2 for `date >= p_self_from`, every other key — and everything before a start date or with a
NULL start date — from legacy. The streak is `vitana_pillar_streak_days_projected` over the same set. All three functions
are STABLE SECURITY DEFINER, EXECUTE for service_role only; the live functions are not touched. The SQL key lists equal
`feature-spec.ts`.
TEST: scripts/ci/sql-tests/run-index-dual-compute-test.sh "key-class routing", "stable + grants" (outputs/sql-index-dual-compute.txt);
test/migrations/vtid-05163-index-dual-compute-migration.test.ts

AC-2 Change 10, the FUNCTIONAL drift guard. The runner extracts the live `health_compute_vitana_index_for_user` and
`vitana_pillar_streak_days` verbatim from the NEWEST migration that defines each, loads identical feature rows into both
tables and asserts live == projection (total, five pillar scores, balance factor, every sub-score, confidence) for all 16
`(p_device_from, p_self_from)` pairs over NULL / before / inside / after the window, across the fixture matrix: each of
the 18 keys and each pillar alone and together; band edges 0/1/3/4/10/11 rows; streaks 0/6/7/13/14/29/30/89/90/95 days,
a one-day gap, broken today, calendar-only, feature-only, alternating; empty days; rows exactly 7 and 8 days old; a row
dated tomorrow; one key/day under two tenants; no baseline survey; tagged and halo completions; non-default weights; every
balance band including a ratio of exactly 0.30. It asserts the matrix reached every balance band and every data / streak
band. Mutations of the copy (band edge 11→12, ratio edge 0.30→0.31, a mental tag dropped, a sleep streak tag dropped,
`>=` 7 days → `>`, confidence 0.85→0.8, glucose routed to v2) each turned it red. CI: `SQL-INDEX-DUAL-COMPUTE.yml`; a
Jest test fails if any migration defining either live function is not covered by its path triggers.
TEST: run-index-dual-compute-test.sh "drift guard"; vtid-05163 migration test "SQL-INDEX-DUAL-COMPUTE.yml — …"

AC-3 `vitana_index_dual_compute` (Aurora only): one row per (member, date, scope `device`|`all`), totals, per-pillar
data/streak sub-scores for both projections, row-set mismatch counts per key class, `diff_class` (CHECK: the seven
classes), `formula_ok`, `failure_code`; service-role only; no FK to `auth.users`; `erase_user_data()` finds it and all four
other B tables (dry-run counts; a real run empties them for that member only). Placement guard refuses a Supabase-shaped
database and a database without `health_features_daily_v2`, leaving nothing behind; `aurora_only_tables` += 1; guarded
Aurora parity lines (verified on a throwaway database: no-op without the table, RLS + grant with it).
TEST: run-index-dual-compute-test.sh "dual-compute table", "erasure discovery", "placement guard"; node --test check-migration-drift (outputs/node-tests.txt)

AC-4 Change 11, the final step of the existing daily recompute (no new route, no new EventBridge rule).
`executePipelineForUser` now returns its per-stage status map; `processDailyRecomputeBatch` runs
`runIndexDualComputeForBatch` after every user's stages and after B2's `features_v2` step, only for the users whose
`index` stage ended `success` for the run date. Its counts live in a separate `dual_compute` field; it never changes
`ok`/`processed`/`skipped`/`failed`/`next_cursor` (also when it reports failures, runs out of budget or throws); with the
flag unset or on staging it is never called and the field is absent. Budget `DUAL_COMPUTE_BATCH_BUDGET_MS` (default
20 s), users past it counted `skipped_budget`; on the run's first batch it purges rows older than 120 days and emits the
daily OASIS report.
TEST: test/health-features/daily-recompute-dual-compute.test.ts (real processDailyRecomputeBatch over a fake PostgREST);
index-dual-compute.test.ts "the batch step"

AC-5 Change 11, one member: the three projections, the live row, R_dev (D6a's own `mapDailyMetricsToFeatures` over the
member's `wearable_daily_metrics` / `wearable_workouts` for dates ≥ D0, providers with `wearables` consent only), the
90-day row-set diff (device keys: v2 vs R_dev; self-logged coded keys, scope `all`: v2 vs the legacy rows of the
re-routed writers — `diary_extractor`, `voice_tool`, `voice_tool_vitals`, and W-manual's `{}` — or the shadow for dates
≥ C after a `derived` cutover, roles swapped), and the classes: `consent_withheld` (S7 key missing/not granted),
`writer_not_rerouted` (a legacy row from a writer outside Change 7, or a key without a store code), `derivation_pending`
(a marker), `derivation_gap` (an observation, no marker, no v2 row), `store_write_failed` (no observation, no marker),
`formula_drift` (legacy projection ≠ live), `not_comparable` (no live row, or the F5 baseline-only row). A failure writes
one failure row per scope (`failure_code`) and never throws. Nothing is emitted per member.
TEST: test/health-features/index-dual-compute.test.ts "one member (Change 11 steps 1–5)" (9 tests)

AC-6 Change 12, the report and the criteria. `GET /api/v1/admin/health/index-dual-compute/report?from&to&scope`
(`routes/admin-health-dual-compute.ts`, `requireAuth` + `requireExafyAdmin`, read only): member-days, compared, job
failures, % Δtotal = 0 (Δtotal = v2 − legacy projection), p50/p95/max |Δtotal|, member-days per class, row mismatches per
key class, formula-drift %, the `consent_withheld` impact (member-days, points), the scope's Stage verdict and B2's
per-writer dual-write failure counters (codes and counts). No member id, no health value, no Index value. 401/403 JSON,
400 on bad input, 503 `DUAL_COMPUTE_STORE_PENDING` while the table is absent. The daily OASIS
`health.index.dual_compute.report` (declared in `types/cicd.ts`) carries the same aggregates. Stage 1 (scope `device`,
from D0) / Stage 2 (scope `all`, from D0s): ≥ 14 consecutive green days after a 7-day warm-up; a day is green with no
job failure, no `derivation_gap`/`store_write_failed`, every mismatch `derivation_pending` that cleared on the member's
next day; formula drift ≤ 0.5%; Stage 2 also Δtotal = 0 on every member-day without `consent_withheld`.
TEST: test/health-features/admin-dual-compute-route.test.ts (5); index-dual-compute.test.ts "report", "Stage 1 / Stage 2"

AC-7 Change 13, the cutover switch (`services/health-features/cutover.ts`). `HEALTH_FEATURES_SOURCE` = `legacy`
(default; unset, any unknown value, staging, or no valid `HEALTH_FEATURES_CUTOVER_DATE` = legacy) | `derived_device` |
`derived`. A writer is cut over when its mode covers it AND its B2 dual-write flag is on; a legacy feature write is cut
over for the mode's keys (device keys / every coded key) and dates ≥ C. In a derived mode the writer writes the same
legacy-shaped row to `health_features_daily_legacy_shadow` (log_meal's running count is read from the shadow), then
`recordToHealthStore(…, {cutover:true})` writes the store, the marker, and runs `deriveAndStore(…, 'live')`
SYNCHRONOUSLY, before the writer's own Index recompute; every failure (store off, no tenant, source, a non-stored
sample, the derivation) is returned: the voice/ORB tools return an error (the model composes the reply), the manual
route answers 503, the diary returns `error_code`, the action returns `ok:false`, the webhook answers 503.
TEST: test/health-features/cutover.test.ts "the switch", "persistFeatureRow …", "recordToHealthStore cutover: true";
cutover-writers.test.ts (derived / derived_device blocks)

AC-8 Change 13, publishing and the bridge / W-sql skips. `deriveAndStore`
target `live` also publishes the mode's keys for dates ≥ C into `health_features_daily` (`metadata.source='derived_v2'`,
insert-only + update only derived rows, stale derived rows deleted, a member's own row never overwritten); with the switch
off it answers `CUTOVER_OFF` and writes nothing; every derivation path (post-write, S8 hook, nightly) follows the switch.
`derived_device`: only the webhook writers and `wearable_log_workout`; the D6a bridge writes the shadow (same insert-only
rules, no Index RPC) and the webhook recomputes the Index once per member instead. `derived`: every re-routed writer;
W-sql is skipped and `/recompute/daily` step 1 derives the member-day instead (same result shape); `biomarker_*` and the
other un-coded keys stay legacy.
TEST: test/health-features/cutover.test.ts (15), cutover-writers.test.ts (derived / derived_device blocks),
vtid-05089-wearable-features-bridge.test.ts "with a shadow writer"

AC-9 Change 14, the rollback. The data fix-up runs in one transaction with `lock_timeout`, refuses to run without
`vitana.health_features_rollback_mode` (`derived_device`|`derived`) and `vitana.health_features_rollback_date` (C),
copies the shadow over `health_features_daily` for dates ≥ C and the mode's keys, deletes `derived_v2` rows with no
shadow counterpart, and raises (rolling everything back) if its post-condition does not hold; it is idempotent; it
never touches dates before C, other keys, or a member's own non-derived row. Its key lists equal the modes' keys.
TEST: run-index-dual-compute-test.sh "rollback fix-up" (missing settings refused with no change; per-mode end states;
second run no change; a tampering trigger makes the guard fail and nothing changes); vtid-05163 migration test

AC-10 The Index members see does not change while the switch is off. For six switch-off states (unset; B2 flags on with
the switch unset; `derived` on staging; `derived` without C; an unknown value; `derived` with both dual-write flags off)
every writer makes exactly its legacy `health_features_daily` write, nothing reaches the shadow (the repository is never
called), `recordToHealthStore` gets `cutover:false` (B2's non-fatal path, so a failing store changes no response), the
bridge writes `health_features_daily` with no shadow option and no extra Index recompute, and `/recompute/daily` runs
W-sql. `deriveAndStore('v2')` and the S8 hook with the switch off never call a live-table method; the dual-compute step
is never called with its flag off or on staging.
TEST: cutover-writers.test.ts "switch OFF (…)" (6 × 4 tests); cutover.test.ts "target v2 never touches …", "the S8 hook …";
daily-recompute-dual-compute.test.ts "flag unset or staging"

AC-11 Regression: B2's suites (writers' assertions now include `{cutover:false}`; the boundary rule now also allows the
read-only S7 key map `consent-gate` and covers `vitana_index_dual_compute`), `vtid-05089`, the webhook bridge route,
`health-log`, `health-depth-tools`, `action-executors`, diary, `routes/health`, `vtid-05025` (+ the dual-compute table),
`vtid-05161`, `health-store`, `test:support` 87, `test:operator` 71, `test:roles` 105. Full `npx jest`: the same 19 suites
fail as on the B2 base (local `libphonenumber-js` / pinpoint module gap), nothing new. The A1/B1/B2/erase SQL suites pass.
TEST: outputs/jest.txt, outputs/jest-full.txt, outputs/tsc.txt, outputs/sql-a1-b1-b2-suites-unchanged.txt

## Not in this package (and why)
- **Activation.** `VITANA_INDEX_DUAL_COMPUTE_ENABLED`, `HEALTH_STORE_DUAL_WRITE_DEVICE_SINCE` (D0),
  `HEALTH_STORE_DUAL_WRITE_SELF_LOGGED_SINCE` (D0s), `HEALTH_FEATURES_SOURCE` and `HEALTH_FEATURES_CUTOVER_DATE` stay unset
  everywhere. The dual-compute starts after B2's device dual-write (D0) is live on Aurora; each cutover is its own config
  deploy and Gate 2 with the Stage report (plan Rollout 5). The rollback fix-up is run only by the owner (Change 14b).
- **The `rollback.md` record** (Change 14b/d) is written only if a rollback ever happens.
- **A signed-in non-admin 403 probe on staging**: the STAGING-VERIFY http harness only sends no token or an invalid bearer;
  the 403 is proven in Jest. The daily-recompute route is a write path and is never called on staging.
- **C1's `self_logged_health` key**: not in this base; the classifier reads the S7 map, so it starts counting
  self-logged consent the moment C1 fills the map.

## Decisions taken inside the plan
1. `vitana_index_projected_feature_rows` is a third STABLE function holding the routing rule once (the plan names two);
   the projection and the projected streak both read it, so the rule cannot diverge between them.
2. The drift guard extracts the live functions from the newest migration that defines each (not "apply every Index
   migration"): those migrations also backfill and recompute other tables; the extracted bodies are byte-identical and a
   later redefinition is picked up automatically.
3. D0 / D0s come from `HEALTH_STORE_DUAL_WRITE_DEVICE_SINCE` / `HEALTH_STORE_DUAL_WRITE_SELF_LOGGED_SINCE` (set together
   with each activation); without D0 the step is skipped (`no_d0`).
4. Δtotal in the report is `v2_total − legacy_total` (both projections at the same instant), so the input switch is measured
   alone; live vs legacy is `formula_drift`.
5. `store_write_failed` is decided from what is observable per member-day — the legacy source has the row, the store has
   no observation and there is no marker — because B2's failure counters are per writer and in-process; the counters
   themselves are reported with the aggregates (report route and daily OASIS event).
6. Extra v2 rows are counted per key class and classed only `derivation_pending` when a marker exists; otherwise they show
   in the row mismatches (and keep a Stage day red).
7. `vitana_index_dual_compute` has `failure_code` (a job failure for that member) and the two pillar sub-score columns as
   jsonb `{pillar: {data, streak}}`.
8. A writer is cut over only when its own B2 dual-write flag is on as well; W-sql is skipped only in `derived` with both
   dual-write flags on; a derived value without a valid C is `legacy`.
9. In a derived mode, every non-stored sample is fatal (S3: "fatal only in derived mode"), including `skipped_no_consent`
   — flagged for the Stage 2 Gate 2 together with Open question 1.
10. Publishing into `health_features_daily` is insert-only + "update only `derived_v2` rows" (the D6a rule), so a
    member's own row is never overwritten and the rollback can delete every `derived_v2` row safely.
11. The diary's chokepoint returns the failure as `error_code` (and counts the cut-over rows as failed); the diary entry
    itself still saves — the three call sites are unchanged.
12. The webhook answers 503 when a cut-over store write or derivation fails (the raw rows are stored, the vendor's retry
    is idempotent) and recomputes the Index once per member in place of the skipped bridge.
13. The bridge's rows go to the shadow only when the bridge itself is enabled (what legacy would have written); with D6a
    dark the shadow holds nothing for device keys, and a `derived_device` rollback removes every derived device row.
14. log_meal's read-modify-write reads its running count from the shadow when cut over, so the shadow keeps exactly the
    legacy value.
15. The rollback fix-up takes its scope from two required session settings, so it can never run with a guessed mode or C.

## Route evidence
ROUTE_MOUNT: `services/gateway/src/index.ts` — `mountRouterSync(app, '/api/v1/admin/health/index-dual-compute', adminHealthDualComputeRouter, { owner: 'admin-health-dual-compute' })`, mounted before the `/api/v1/admin` catch-all routers; the router applies `requireAuth, requireExafyAdmin` to every route.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/health/index-dual-compute/report
CURL_PROOF: read-only, after the staging deploy: `curl -s -o /dev/null -w '%{http_code} %{content_type}' https://preview-aws-gateway.vitanaland.com/api/v1/admin/health/index-dual-compute/report` must answer `401 application/json` (and `401` JSON with an invalid bearer); `GET /api/v1/admin/build-info` answers `200 application/json`. No POST is ever sent to staging (the switch and the dual-compute are forced off there; every write path is proven in Jest and on a throwaway Postgres).

## OASIS
OASIS_PROOF: one new event type declared in `services/gateway/src/types/cicd.ts`, `vtid: 'VTID-05163'`, `source: 'health-features'`, `actor_role: 'system'`: `health.index.dual_compute.report` — once per run (on the first batch) for the previous run date, payload = the day's and the stage-to-date aggregates per scope, the Stage verdicts and B2's per-writer failure counters; never a member id or a health value (asserted in index-dual-compute.test.ts "only users whose index stage succeeded; … daily report on the first batch": the payload contains no `user_id` and no member id). Emitted only with `VITANA_INDEX_DUAL_COMPUTE_ENABLED` on, never on staging.
