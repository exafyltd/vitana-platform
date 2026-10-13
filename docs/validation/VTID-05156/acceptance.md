# VTID-05156 — acceptance criteria (Health Hub Phase 0 fix-ups, gateway half "PLAT-FIX")

Plan: `docs/validation/VTID-05156/plan-sparring.md` (shared with VTID-05155 in vitana-v1). This PR implements Changes 4, 5, 7 and 8 (Defects 2, 3 and 5). Change 6 (Defect 4) is NOT in this PR: it depends on `NOT_PUBLISHED_MISSING` from PR #4057 (VTID-05090) and follows after #4057 merges.

AC-1 (Defect 2) `find_perfect_match` reads only the member's own active Life Compass goal (`life_compass`, `primary_goal`/`category`, `is_active`, newest first). It never queries `vitana_index_scores`; the mocked client's table list is exactly `['life_compass']`.
TEST: npx jest test/orb-tools/discovery-tools.test.ts -t "find_perfect_match"

AC-2 (Defect 2) With no `ask`, the tool always returns `stage: 'needs_ask'` and an instruction to ask the member, even when Index data exists; `runFindMatch` is never called, so nothing derived from health data can be posted to the intent board. `PILLAR_DEFAULT_ASK` and the derived ask are gone.
TEST: npx jest test/orb-tools/discovery-tools.test.ts -t "asks the member"

AC-3 (Defect 2) The result has no `weakest_pillar`; `ask_derived_from_pillar` is kept for shape compatibility and is always `false`. The PERSONALIZATION prefix names only the Life Compass goal (English intent text for the model, not a spoken sentence); with no goal there is no prefix.
TEST: npx jest test/orb-tools/discovery-tools.test.ts -t "Life Compass goal only|no personalisation prefix"

AC-4 (Defect 2) The `find_perfect_match` declaration (description and `ask` parameter) no longer mentions the weakest pillar or the Vitana Index. The voice-payload and characterization snapshots differ only in those description lines and the tool-catalog hash/bytes (no instruction hash changed). `tool-manifest.json` needs no change: its `find_perfect_match` description never mentioned the pillar.
TEST: npx jest test/orb-tools/discovery-tools.test.ts -t "declaration"; npx jest test/orb/latency/vtid-04542-voice-payload-identity.test.ts test/orb/live/characterization

AC-5 (Defect 2) Source scan: `services/orb-tools/discovery-tools.ts` and `discovery-tools-repository.ts` name no health-data table (same list as the VTID-05025 suite) and import no wearable module; `getCompassAndWeakestPillar`, `PILLAR_DEFAULT_ASK` and `fetchLatestVitanaIndexScore` are gone. The VTID-05025 commerce module list is unchanged.
TEST: npx jest test/vtid-05156-people-match-health-boundary.test.ts

AC-6 (Defect 3) `find_perfect_product` and `find_perfect_practitioner` read `life_compass` with `select('primary_goal')`, `eq('user_id')`, `eq('is_active', true)`, `order('created_at', desc)`, `limit(1)` — never `current_goal`. An active goal appears in `compass_goal`, `rationale` and the text.
TEST: npx jest test/vtid-05156-marketplace-compass-goal.test.ts -t "selects primary_goal|an active goal"

AC-7 (Defect 3) A returned PostgREST error gives `compass_goal: null`, exactly one `console.warn('[find_perfect_<tool>] life_compass read failed: <code>')`, and the catalog results are still returned. No goal → `null`, no warning.
TEST: npx jest test/vtid-05156-marketplace-compass-goal.test.ts -t "PostgREST error|no active goal"

AC-8 (Defect 3) The VTID-05025 commerce/health boundary suite stays green; its recording client now returns the real column (`primary_goal`) — the old mock returned the non-existent `current_goal`, which is why the defect was invisible.
TEST: npx jest test/vtid-05025-commerce-health-boundary.test.ts

AC-9 (Defect 5) `POST /api/v1/health/wearables/ingest` answers `410 {ok:false, error:'ENDPOINT_RETIRED'}` with or without a token and with any body, before any database call: no Supabase client is built, no RPC (`me_context` or `health_ingest_wearable_samples`) and no OASIS event.
TEST: npx jest test/routes/health.test.ts -t "retired"

AC-10 (Defect 5) Migration `20261014120000_vtid_05156_revoke_wearable_samples_rpc.sql`: on a throwaway Postgres with the live ACL shape, `authenticated` and `anon` lose EXECUTE on `health_ingest_wearable_samples(jsonb)`, `service_role` keeps it, the ACL is exactly `{owner, service_role}`, re-apply is a no-op, a `PUBLIC` grant is removed, `health_ingest_lab_report` is untouched, and a missing function fails loudly. Committed, NOT applied: applied via `RUN-MIGRATION.yml` after Gate 2, with a read-only before/after `has_function_privilege` check recorded in Gate 2.
TEST: bash scripts/ci/sql-tests/run-wearable-samples-rpc-revoke-test.sh (CI: SQL-WEARABLE-SAMPLES-RPC-REVOKE.yml)

AC-11 Guard suites stay green: customer support (`npm run test:support`), operator (`npm run test:operator`), roles (`npm run test:roles`), VTID-04968 delegation guard, VTID-05041 definer lockdown. The gateway type-checks with no error in a touched file.
TEST: npm run test:support; npm run test:operator; npm run test:roles; npx jest test/vtid-04968-delegation-guard.test.ts test/vtid-05041-definer-lockdown.test.ts; npx tsc --noEmit -p .

OASIS_PROOF: no new OASIS event type. The retired wearable route no longer emits `health.ingest.wearable` / `health.ingest.wearable.error` (it answers 410 before any work); AC-9 asserts no event fires.
TEST: npx jest test/routes/health.test.ts -t "retired"

ROUTE_MOUNT: services/gateway/src/routes/health.ts → router.post('/wearables/ingest') (existing handler, body replaced by a 410; no new route); mounted in src/index.ts via mountRouterSync at /api/v1/health (unchanged)
FINAL_URL: POST {gateway}/api/v1/health/wearables/ingest
CURL_PROOF: NOT run against staging — a POST that is not a 401/403 auth-rejected probe is outside the read-only staging rule (staging shares the production database). Expected on a local or test gateway only: `curl -s -o /dev/null -w "%{http_code} %{content_type}" -X POST "$GATEWAY/api/v1/health/wearables/ingest"` → `410 application/json` with body `{"ok":false,"error":"ENDPOINT_RETIRED"}`. Proven in Jest (AC-9); staging checks only GET /alive and GET /api/v1/admin/build-info.
