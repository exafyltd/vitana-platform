-- VTID-NAV-JOURNEY-NEWS (follow-up): drop AUTOPILOT.MY_JOURNEY priority
-- boost. The previous migration set priority=5 to nudge "my journey" phrases
-- onto /autopilot. In practice that boost was ALSO tipping scoring on
-- neighboring phrases — "open my profile" was landing on /autopilot because
-- PROFILE.ME had no DB row (the SQL seed is incomplete) so the navigator
-- fell through to the next-best scorer, and priority=5 put AUTOPILOT there.
--
-- With gap-fill from the compile-time catalog (see nav-catalog-db.ts) and
-- the override_triggers already covering the "my journey" phrasings, this
-- priority boost is redundant and harmful. Set it back to 0.
--
-- Idempotent. Safe to re-run.

BEGIN;

UPDATE nav_catalog
SET priority = 0,
    updated_at = NOW()
WHERE screen_id = 'AUTOPILOT.MY_JOURNEY'
  AND tenant_id IS NULL;

COMMIT;
