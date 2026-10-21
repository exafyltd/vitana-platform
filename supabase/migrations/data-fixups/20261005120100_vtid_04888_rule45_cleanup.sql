-- VTID-04888 data fix-up (CLAUDE.md rule 45): remove test/service accounts from everything a real member can see
-- through Find-a-Match and the member lists. Applied once, right after
-- 20261005120000_vtid_04888_rule45_intents_profiles.sql. Idempotent: a second run changes nothing.
--
-- Counted read-only 2026-10-05 (docs/validation/VTID-04888/outputs/): 3 excluded accounts, 3 visible profiles,
-- 18 open intents, 16 recommendation rows on their intents, 11 real members' recommendation rows listing one of
-- their intents, 173 intent_matches rows involving them. intent_events / intent_disputes (ON DELETE CASCADE),
-- user_ratings / service_payments (SET NULL), match_notifications and autopilot_prompts hold no row for those
-- matches; the guard below aborts the whole fix-up if that has changed.
--
-- Not rolled back: showing test accounts to members again would re-break rule 45.

BEGIN;

CREATE TEMP TABLE _x45_accounts ON COMMIT DROP AS
  SELECT user_id FROM public.service_bot_accounts
  UNION
  SELECT user_id FROM public.notification_test_actors;

CREATE TEMP TABLE _x45_vitana_ids ON COMMIT DROP AS
  SELECT p.vitana_id FROM public.profiles p
   WHERE p.user_id IN (SELECT user_id FROM _x45_accounts) AND p.vitana_id IS NOT NULL;

CREATE TEMP TABLE _x45_intents ON COMMIT DROP AS
  SELECT intent_id FROM public.user_intents
   WHERE requester_user_id IN (SELECT user_id FROM _x45_accounts);

CREATE TEMP TABLE _x45_matches ON COMMIT DROP AS
  SELECT match_id FROM public.intent_matches
   WHERE intent_a_id IN (SELECT intent_id FROM _x45_intents)
      OR intent_b_id IN (SELECT intent_id FROM _x45_intents)
      OR external_target_id IN (SELECT user_id FROM _x45_accounts);

-- Guard: never delete a match something real hangs off.
DO $$
DECLARE n int;
BEGIN
  SELECT (SELECT count(*) FROM public.intent_events      WHERE match_id IN (SELECT match_id FROM _x45_matches))
       + (SELECT count(*) FROM public.intent_disputes    WHERE match_id IN (SELECT match_id FROM _x45_matches))
       + (SELECT count(*) FROM public.user_ratings       WHERE match_id IN (SELECT match_id FROM _x45_matches))
       + (SELECT count(*) FROM public.service_payments   WHERE match_id IN (SELECT match_id FROM _x45_matches))
       + (SELECT count(*) FROM public.match_notifications WHERE match_id IN (SELECT match_id FROM _x45_matches))
       + (SELECT count(*) FROM public.autopilot_prompts  WHERE match_id IN (SELECT match_id FROM _x45_matches))
    INTO n;
  IF n > 0 THEN
    RAISE EXCEPTION 'VTID-04888 fix-up aborted: % dependent row(s) reference matches of excluded accounts', n;
  END IF;
END $$;

-- 1. Hide their community profiles.
UPDATE public.global_community_profiles SET is_visible = false
 WHERE user_id IN (SELECT user_id FROM _x45_accounts) AND is_visible;

-- 2. Close their live intents.
UPDATE public.user_intents SET status = 'closed'
 WHERE intent_id IN (SELECT intent_id FROM _x45_intents) AND status IN ('open', 'matched', 'engaged');

-- 3. Matchmaker output for their own intents.
DELETE FROM public.intent_match_recommendations
 WHERE intent_id IN (SELECT intent_id FROM _x45_intents);

-- 4. Real members' matchmaker output: drop the excluded candidates; the spoken readback and the summary were
--    written around the old list, so they go too (the UI falls back to the candidate list).
UPDATE public.intent_match_recommendations r
   SET candidates = (SELECT coalesce(jsonb_agg(c), '[]'::jsonb)
                       FROM jsonb_array_elements(r.candidates) c
                      WHERE NOT (coalesce(c->>'intent_id', '') IN (SELECT intent_id::text FROM _x45_intents)
                              OR coalesce(c->>'vitana_id', '') IN (SELECT vitana_id FROM _x45_vitana_ids))),
       voice_readback = NULL,
       reasoning_summary = NULL,
       updated_at = now()
 WHERE jsonb_typeof(r.candidates) = 'array'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.candidates) c
                WHERE coalesce(c->>'intent_id', '') IN (SELECT intent_id::text FROM _x45_intents)
                   OR coalesce(c->>'vitana_id', '') IN (SELECT vitana_id FROM _x45_vitana_ids));

-- 5. Matches involving them.
DELETE FROM public.intent_matches WHERE match_id IN (SELECT match_id FROM _x45_matches);

COMMIT;
