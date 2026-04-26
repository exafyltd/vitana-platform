-- Vitana Intent Engine — P2-A · 6/9
-- VTID-01973
--
-- Daily recompute RPC. Re-runs compute_intent_matches() for any open
-- intent created in the last 14 days that still has match_count = 0,
-- to catch late-arriving counterparties. Mirrors the VTID-01095
-- daily_scheduler pattern.
--
-- Idempotent — compute_intent_matches() inserts ON CONFLICT DO NOTHING,
-- so re-runs don't duplicate match rows.
--
-- Called by an external scheduler (Cloud Scheduler / worker-runner) in
-- P2-C; for now the route layer can invoke it via a developer endpoint
-- for smoke testing.

CREATE OR REPLACE FUNCTION public.compute_intent_matches_daily(
  p_lookback_days  int  DEFAULT 14,
  p_top_n          int  DEFAULT 5,
  p_max_intents    int  DEFAULT 200
) RETURNS TABLE (
  scanned    int,
  inserted   int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec     record;
  scanned int := 0;
  inserted_total int := 0;
  inserted_one int;
BEGIN
  FOR rec IN
    SELECT intent_id
      FROM public.user_intents
     WHERE status IN ('open','matched','engaged')
       AND embedding IS NOT NULL
       AND match_count = 0
       AND created_at > now() - (p_lookback_days || ' days')::interval
     ORDER BY created_at DESC
     LIMIT p_max_intents
  LOOP
    inserted_one := public.compute_intent_matches(rec.intent_id, p_top_n);
    inserted_total := inserted_total + COALESCE(inserted_one, 0);
    scanned := scanned + 1;
  END LOOP;

  RETURN QUERY SELECT scanned, inserted_total;
END;
$$;

COMMENT ON FUNCTION public.compute_intent_matches_daily(int, int, int) IS
  'Cron-callable recompute. Re-runs compute_intent_matches for stuck (match_count=0) open intents within the lookback window. Returns (scanned, inserted) counts.';
