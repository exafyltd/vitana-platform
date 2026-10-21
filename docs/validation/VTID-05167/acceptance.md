# VTID-05167 — acceptance (Life Timeline P1: stop the noise + classify)

Production facts this phase is built on (read-only, 2026-10-13/14):
- `user_activity_log` ≈ 171,742 rows. Last 120 days by type: `orb.livekit.next_action.candidate` 59,238 ·
  `page.view` 29,906 · `auth.login` 11,102 · `orb.session.identity.resolved` 7,336 ·
  `orb.session.continuity.persisted` 7,170 · `orb.livekit.next_action.suppressed` 5,840 ·
  `orb.session.audio_ready.acked` 4,217 · `orb.session.profile.resolved` 1,321 · `discover.view` 1,204 ·
  `orb.livekit.next_action.suggested` 946 · `community.follow` 249 · `auth.signup` 178 · smaller types below 40.
  About 86,000 of those rows are internal assistant telemetry; a few hundred are member moments.
- `user_activity_log_archive` is empty, has no `source` column and still carries the 13-value
  `chk_activity_type` allowlist, so the never-scheduled `archive_old_activity_logs()` (`INSERT … SELECT *`)
  could not have run successfully. pg_cron is installed.

AC-1 Internal telemetry never reaches a member's history: `projectOasisEventToTimeline` and `writeTimelineRow`
post nothing for `orb.livekit.next_action.*`, `orb.navigator.*`, `orb.session.identity.resolved` and every other
`system` type; a member moment (`diary.create`) is still posted.
TEST: npx jest test/vtid-05167-timeline-catalog.test.ts -t "projector never writes system telemetry"
RED: the same suite against the pre-change projector: 7 failed / 7 passed (outputs/jest-red-old-projector.txt).

AC-2 The catalog is well formed; its pillars are exactly the Vitana Index pillars (`lib/vitana-pillars.ts`);
every pillar has at least one visible moment; every activity type members had in the last 120 days is classified
by an explicit entry (no default fall-through).
TEST: npx jest test/vtid-05167-timeline-catalog.test.ts -t "timeline catalog"

AC-3 The migration's `activity_catalog` seed is byte-identical to what
`scripts/timeline/generate-activity-catalog-seed.mjs` renders from the JSON; the tier/pillar checks match.
TEST: npx jest test/vtid-05167-timeline-catalog.test.ts -t "seed|checks match"

AC-4 Migration on a throwaway Postgres (twice, idempotent): lookup exact > longest prefix > NULL; backfill newest
first in batches, reports 0 when done, deletes nothing; trigger classifies frontend rows and never overwrites
provided values; tier/pillar checks reject bad values; archive moves only silent/system rows older than 180 days
and keeps old moments; members cannot run the definer functions, can read (not write) the catalog, anon cannot.
TEST: scripts/ci/sql-tests/run-activity-tiers-test.sh (CI: SQL-ACTIVITY-TIERS.yml)
RED: archive without the tier filter → "archive must move exactly the 2 old silent/system rows, moved 3".

AC-5 Aurora restore additions (defaults, checks, indexes, trigger, RLS, policy) run cleanly after the migration.
TEST: outputs/aurora-mirror-check.txt (local throwaway Postgres)

AC-6 No regression: typecheck; neighbouring suites; definer-grant guard; drift-baseline unit tests.
TEST: npx tsc --noEmit -p services/gateway; npx jest test/services/realtime/generic-cursor-relay.test.ts
test/vtid-04785-session-end-telemetry.test.ts test/vtid-04886-ops-attention-acks-timeline.test.ts
test/vtid-05041-definer-lockdown.test.ts; node --test scripts/ci/check-migration-drift.test.cjs

Applying the migration: only via `RUN-MIGRATION.yml` after Gate 2. Read-only post-apply checks:
  SELECT count(*) FROM activity_catalog;                                           -- expect 132
  SELECT jobname, schedule FROM cron.job WHERE jobname LIKE 'activity-%';          -- backfill + archive
  SELECT count(*) FROM user_activity_log WHERE tier IS NULL;                       -- falls to 0 within ~35 min
  SELECT tier, count(*) FROM user_activity_log GROUP BY 1;                         -- system ≈ the orb.* volume
  SELECT has_function_privilege('authenticated','public.archive_old_activity_logs()','execute');  -- false
