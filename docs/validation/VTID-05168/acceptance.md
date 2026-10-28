# VTID-05168 — acceptance (Life Timeline P2: Vitana Index movements + pillar logging)

Live facts this phase is built on (read-only, 2026-10-14): `health_compute_vitana_index_for_user(uuid,date,text)`
(SECURITY DEFINER; ACL postgres, service_role, migrate) is the canonical compute; the nightly scheduler and the
`calendar_events` completion trigger call it; the member overloads `health_compute_vitana_index(date,text)` and
`(date)` score with their own older bodies (no community tags for Mental — B15). Nine gateway call sites recompute;
only the calendar route and guided-journey emitted a delta, the calendar one without `actor_id`. The baseline survey
upserted a TypeScript-only score directly (F15).

AC-1 One locked writer: `vitana_index_recompute_and_record()` takes a per-member advisory lock, records a movement
only when a score changed (first score ever included), compares the first recompute of a day with the latest earlier
day, refuses an invalid trigger; two near-simultaneous recomputes each carry only their own change.
TEST: scripts/ci/sql-tests/run-index-movements-test.sh (CI: SQL-INDEX-MOVEMENTS.yml)
RED: with the advisory lock removed the concurrency phase fails: "B must carry only exercise +15 (stale before?):
{… "exercise": 15, "hydration": 10 …}" (outputs/sql-red-no-lock.txt).

AC-2 Every SQL-side path is routed through it: old name (`unspecified`), nightly scheduler (`daily`), calendar
trigger (`calendar_completion` + event id), member overloads (`self_heal`, `auth.uid()`, shapes kept, refusal without
a user). Privileges: members cannot run the recording function, the core or `_for_user`; `migrate` loses the core;
members keep both overloads; nobody but the definer writes movements. Idempotent (applied twice).
TEST: scripts/ci/sql-tests/run-index-movements-test.sh

AC-3 Gateway helper calls the recording RPC with trigger + source; falls back to the old RPC only on "function not
found" for the recording function (migration not yet applied), never on any other error.
TEST: npx jest test/vtid-05168-index-movements.test.ts -t "recordIndexRecompute"

AC-4 Pillar logs become timeline moments linked to the movement: voice `log_water/sleep/exercise/meditation`,
`log_meal`, `log_mood`, manual log; each `health.log.*` kind is a visible catalog moment of its pillar; only catalog
params are written. Guided Journey +2 becomes its own `journey.session.listened` moment.
TEST: npx jest test/vtid-05168-index-movements.test.ts -t "pillar log moments"

AC-5 Single-writer guard: no gateway code writes `vitana_index_scores` and only `record-recompute.ts` names the
legacy/core RPC; the migration routes every SQL path through the recording function.
TEST: npx jest test/vtid-05168-index-movements.test.ts -t "single writer guard"
RED: the same guard over origin/main's source flags routes/health-repository.ts (direct upsert) and 7 direct-RPC
files (outputs/guard-red-main.txt).

AC-6 Baseline survey: saves the answers, computes through the recording function (`baseline_survey`), returns the
canonical pillars; 400 SCORE_WRITE_FAILED when the compute fails; no direct scores write.
TEST: npx jest test/routes/health.test.ts -t "baseline"

AC-7 Calendar completion reports the delta recorded for that event (the DB trigger has already recomputed, so the
route's own before/after diff was 0) and emits `index.recomputed` with `actor_id` = the member.
TEST: npx jest test/calendar/calendar-routes.contract.test.ts

AC-8 Rollback restores the exact pre-migration functions from the pre-apply capture.
TEST: outputs/rollback-roundtrip.txt (throwaway Postgres: capture → migrate → rollback → old function scores again)

AC-9 No regression: typecheck; 214 related suites (health, index, calendar, diary, integrations, wearable, memory,
voice/orb tools, pillar, guided, timeline, characterization) — 4,290 passed, 18 skipped; Guided Journey 209 passed.
TEST: npx tsc --noEmit -p services/gateway; outputs/jest-related.txt

Applying (after Gate 2, via RUN-MIGRATION.yml): first run pre-apply-capture.sql and pre-apply-grants.sql READ-ONLY and
keep the output as pre-apply-definitions.sql. Read-only post-apply checks:
  SELECT to_regprocedure('public.health_compute_vitana_index_core(uuid,date,text)') IS NOT NULL;            -- true
  SELECT has_function_privilege('authenticated','public.vitana_index_recompute_and_record(uuid,date,text,text,text,text)','execute'); -- false
  SELECT trigger, count(*) FROM vitana_index_movements WHERE at > now() - interval '1 day' GROUP BY 1;     -- grows after 02:00 UTC
