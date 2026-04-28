-- Probe: verify D11/D12 end-to-end is working as intended
DO $$
DECLARE
  r record;
  v_total_calls int;
  v_match_calls int;
BEGIN
  RAISE NOTICE '=== Last 5 intents — embedding presence + matches ===';
  FOR r IN
    SELECT
      ui.intent_id,
      ui.requester_vitana_id,
      ui.intent_kind,
      ui.category,
      ui.match_count,
      ui.embedding IS NOT NULL AS has_embedding,
      vector_dims(ui.embedding) AS embedding_dims,
      ui.created_at
    FROM public.user_intents ui
    WHERE ui.created_at > now() - interval '6 hours'
    ORDER BY ui.created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE 'intent: % @% kind=% cat=% match_count=% has_embed=% dims=% at=%',
      substring(r.intent_id::text from 1 for 8),
      r.requester_vitana_id, r.intent_kind, r.category,
      r.match_count, r.has_embedding,
      COALESCE(r.embedding_dims, 0), r.created_at;
  END LOOP;

  RAISE NOTICE '=== gemini_call_log totals ===';
  SELECT count(*) INTO v_total_calls FROM public.gemini_call_log;
  SELECT count(*) INTO v_match_calls FROM public.gemini_call_log WHERE feature = 'matchmaker';
  RAISE NOTICE 'total calls logged: %', v_total_calls;
  RAISE NOTICE 'matchmaker calls : %', v_match_calls;

  RAISE NOTICE '=== gemini_call_log per feature (last 24h) ===';
  FOR r IN
    SELECT feature, model, count(*) AS calls, avg(latency_ms)::int AS avg_ms
      FROM public.gemini_call_log
     WHERE created_at > now() - interval '24 hours'
     GROUP BY 1, 2
     ORDER BY calls DESC
  LOOP
    RAISE NOTICE '  feature=% model=% calls=% avg_latency_ms=%', r.feature, r.model, r.calls, r.avg_ms;
  END LOOP;

  RAISE NOTICE '=== Recent intent_matches with kind_pairing activity_seek::activity_seek (the dance partner case) ===';
  FOR r IN
    SELECT m.match_id, m.vitana_id_a, m.vitana_id_b, m.score, m.match_reasons, m.created_at
      FROM public.intent_matches m
     WHERE m.kind_pairing = 'activity_seek::activity_seek'
       AND m.created_at > now() - interval '6 hours'
     ORDER BY m.created_at DESC
     LIMIT 10
  LOOP
    RAISE NOTICE '  match: @% → @% score=% mode=%',
      r.vitana_id_a, r.vitana_id_b, r.score,
      COALESCE(r.match_reasons->>'mode', '?');
  END LOOP;
END;
$$;
