# VTID-05171 — acceptance (Life Timeline P5: companion wiring)

ROUTE_MOUNT: services/gateway/src/routes/timeline.ts (existing router, mounted at /api/v1/timeline by VTID-05169) — seven routes added before '/:id'.
FINAL_URL: GET/PUT {gateway}/api/v1/timeline/learning-prefs, GET {gateway}/api/v1/timeline/usage-data, GET {gateway}/api/v1/timeline/usage-data/export, DELETE {gateway}/api/v1/timeline/usage-data, GET {gateway}/api/v1/timeline/routines, DELETE {gateway}/api/v1/timeline/routines/:id
CURL_PROOF: on staging only the anonymous GETs (staging-tests.json): `curl -s -o /dev/null -w "%{http_code} %{content_type}" https://preview-aws-gateway.vitanaland.com/api/v1/timeline/learning-prefs` → `401 application/json` (also /usage-data, /usage-data/export, /routines). The PUT and the DELETE are proven in Jest (staging shares the production database; writes are never probed).
OASIS_PROOF: AP-0916 emits `autopilot.memory.timeline_habits_rolled_up` (counts only) through the automation context, like AP-0915; no other event added or changed.

AC-1 Profiler: the 14-day activity read asks the database only for tier spotlight/moment/digest, not hidden_from_ai,
not in a category the member switched off (fixes B9); before the VTID-05167 columns exist it falls back to the old
query. The [HEALTH] block gains "What moved the Index this week" from vitana_index_movements and last_movement comes
from the latest recorded movement (old index.recomputed event only as fallback).
TEST: npx jest test/vtid-05171-companion-wiring.test.ts -t "profiler"

AC-2 Habit rollup (AP-0916, own automation, AP-0906 unchanged): screen_habit, active_hours, feature_affinity,
pillar_rhythm from 28 days; conservative thresholds; upsert on (user, kind, key); stale rows of only these kinds
deleted; app_usage off → no app-usage routines; a category off or a row hidden from Vitana never counts.
TEST: npx jest test/vtid-05171-companion-wiring.test.ts -t "habit rollup"

AC-3 "Vitana noticed": ≤1 per member per day (dedupe key), spotlight tier `index.insight.noticed` with catalog params
only (insight_kind, pillar); weakest pillar ≥5 days while balance costs points, else ±10 in a week; never the same
insight twice in 7 days; never about a pillar switched off.
TEST: npx jest test/vtid-05171-companion-wiring.test.ts -t "noticed|runner"

AC-4 get_my_timeline: registered community domain tool; structured facts (no spoken sentence, rule 41); hidden rows
out; measured only from a movement, else counted; special-category moments carry the topic only; bad pillar/category
refused; packed LAST on the byte-budgeted catalogs (never displaces a priority or ordinary tool, first dropped).
TEST: npx jest test/vtid-05171-companion-wiring.test.ts -t "get_my_timeline"

AC-5 Learning switches and usage data: GET lists every learnable category (missing row = on); PUT validates, writes
only for the JWT user, app_usage off deletes the app-usage routines, 409 before the migration; usage-data count,
JSON export and delete (main table + archive + app-usage routines), silent/system tiers only, JWT user only.
Routines: the member's own (confidence ≥ 0.5, kind + key + metadata, never the English title/summary); forget one by
id (400 bad id, 404 not theirs).
TEST: npx jest test/vtid-05171-companion-wiring.test.ts -t "learning-prefs"

AC-6 Migration: four routine kinds accepted, unknown rejected, existing rows kept; timeline_learning_prefs defaults,
category list, owner-only RLS (read/insert/update), anon none; idempotent. Red when the policy is widened.
TEST: scripts/ci/sql-tests/run-companion-wiring-test.sh (CI: SQL-COMPANION-WIRING.yml)

AC-7 No regression: typecheck; roles suite; EventBridge/automation-shadow pins (+1 job); full gateway Jest.
TEST: npx tsc --noEmit -p services/gateway; npx jest test/vtid-04560-role-separation-regression.test.ts test/vtid-04226-eventbridge-test-contract-schedules.test.ts test/vtid-04349-automation-shadow.test.ts
