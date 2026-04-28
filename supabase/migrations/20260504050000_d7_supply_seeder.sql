-- D7 supply seeder (VTID-DANCE-D7)
-- Daily cron: for every public intent open >24h with match_count=0, scan
-- profiles.dance_preferences (matching variety) for up to 3 candidates and
-- emit OASIS soft-ask events. The notifier service picks these up and
-- delivers in-app pushes. Idempotent per (intent_id, candidate_user_id).

CREATE TABLE IF NOT EXISTS public.intent_supply_seeded (
  intent_id        uuid NOT NULL REFERENCES public.user_intents(intent_id) ON DELETE CASCADE,
  candidate_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  seeded_at        timestamptz NOT NULL DEFAULT now(),
  reason           text,
  PRIMARY KEY (intent_id, candidate_user_id)
);

COMMENT ON TABLE public.intent_supply_seeded IS
  'D7: idempotency tracker for the supply-seeder cron. One row per (intent, candidate) pair so we never soft-ask the same person twice for the same intent.';

CREATE OR REPLACE FUNCTION public.intent_supply_seeder_run()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int := 0;
  r record;
  c record;
  v_variety text;
BEGIN
  -- Walk every stale, public, zero-match dance intent.
  FOR r IN
    SELECT ui.intent_id, ui.requester_user_id, ui.requester_vitana_id,
           ui.intent_kind, ui.category, ui.title,
           lower((ui.kind_payload -> 'dance') ->> 'variety') AS variety
      FROM public.user_intents ui
     WHERE ui.status = 'open'
       AND ui.visibility = 'public'
       AND ui.match_count = 0
       AND ui.created_at < now() - interval '24 hours'
       AND ui.category LIKE 'dance.%'
       AND (ui.expires_at IS NULL OR ui.expires_at > now())
  LOOP
    v_variety := r.variety;
    -- Pick up to 3 candidates whose dance_preferences include this variety,
    -- excluding the requester and anyone we've already seeded for this intent.
    FOR c IN
      SELECT p.user_id
        FROM public.profiles p
       WHERE p.user_id <> r.requester_user_id
         AND p.dance_preferences IS NOT NULL
         AND v_variety IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(p.dance_preferences -> 'varieties') v(elem)
            WHERE lower(v.elem) = v_variety
         )
         AND NOT EXISTS (
           SELECT 1 FROM public.intent_supply_seeded s
            WHERE s.intent_id = r.intent_id AND s.candidate_user_id = p.user_id
         )
       LIMIT 3
    LOOP
      INSERT INTO public.intent_supply_seeded (intent_id, candidate_user_id, reason)
      VALUES (
        r.intent_id, c.user_id,
        format('dance.variety match: %s', v_variety)
      )
      ON CONFLICT DO NOTHING;

      -- Emit OASIS event so the notifier picks it up and delivers a push.
      INSERT INTO public.oasis_events (topic, vtid, status, message, metadata)
      VALUES (
        'intent.supply_seeded',
        'VTID-DANCE-D7',
        'info',
        format('Supply seed: @%s might fit a %s ask', r.requester_vitana_id, v_variety),
        jsonb_build_object(
          'intent_id',      r.intent_id,
          'requester_vitana_id', r.requester_vitana_id,
          'candidate_user_id',   c.user_id,
          'category',       r.category,
          'variety',        v_variety,
          'title',          r.title
        )
      );

      v_count := v_count + 1;
    END LOOP;
  END LOOP;

  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.intent_supply_seeder_run() IS
  'D7: scans 24h-stale dance intents with no matches, suggests up to 3 candidates per intent based on profile.dance_preferences variety match. Idempotent. Run daily.';

DO $$
BEGIN
  PERFORM cron.unschedule('intent_supply_seeder_daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'intent_supply_seeder_daily',
  '45 4 * * *',
  $cron$ SELECT public.intent_supply_seeder_run() $cron$
);
