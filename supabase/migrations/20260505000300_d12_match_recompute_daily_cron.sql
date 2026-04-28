-- D12 daily match recompute (VTID-DANCE-D12)
-- During the credit window: re-run compute_intent_matches() for every
-- open intent whose match_count is still 0, and for any open intent
-- whose embedding is now populated but didn't have one when posted.
-- This catches the post-fix backfill so users don't have to re-post.

CREATE OR REPLACE FUNCTION public.intent_matches_recompute_daily()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  v_total int := 0;
BEGIN
  FOR r IN
    SELECT intent_id
      FROM public.user_intents
     WHERE status = 'open'
       AND created_at > now() - interval '14 days'
       AND match_count = 0
     ORDER BY created_at DESC
     LIMIT 200
  LOOP
    PERFORM public.compute_intent_matches(r.intent_id, 5);
    v_total := v_total + 1;
  END LOOP;

  RETURN v_total;
END;
$$;

COMMENT ON FUNCTION public.intent_matches_recompute_daily() IS
  'D12: re-runs compute_intent_matches for every open zero-match intent in the last 14 days. Catches misses after the embedding pipeline gets fixed and after new compatible intents arrive.';

DO $$
BEGIN
  PERFORM cron.unschedule('intent_matches_recompute_daily');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'intent_matches_recompute_daily',
  '15 5 * * *',  -- 05:15 UTC daily
  $cron$ SELECT public.intent_matches_recompute_daily() $cron$
);
