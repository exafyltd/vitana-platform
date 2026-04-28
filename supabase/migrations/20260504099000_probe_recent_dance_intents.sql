-- Read-only probe: show the most recent ~10 intents that look dance-related
-- so we can diagnose why two "looking for somebody to dance" posts didn't match.
DO $$
DECLARE
  r record;
BEGIN
  RAISE NOTICE '=== Last 10 dance-or-activity intents (most recent first) ===';
  FOR r IN
    SELECT
      ui.intent_id,
      ui.requester_vitana_id,
      ui.intent_kind,
      ui.category,
      ui.title,
      ui.kind_payload,
      ui.embedding IS NOT NULL AS has_embedding,
      ui.match_count,
      ui.status,
      ui.visibility,
      ui.tenant_id,
      ui.created_at
    FROM public.user_intents ui
    WHERE ui.created_at > now() - interval '7 days'
      AND (
        ui.category LIKE 'dance.%'
        OR ui.intent_kind IN ('activity_seek','learning_seek','mentor_seek')
        OR lower(ui.title) LIKE '%danc%'
        OR lower(ui.scope) LIKE '%danc%'
      )
    ORDER BY ui.created_at DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '------';
    RAISE NOTICE 'created   : %', r.created_at;
    RAISE NOTICE 'requester : @%', r.requester_vitana_id;
    RAISE NOTICE 'kind/cat  : % / %', r.intent_kind, COALESCE(r.category, '<null>');
    RAISE NOTICE 'title     : %', r.title;
    RAISE NOTICE 'has_embed : %    match_count: %    status: %    visibility: %', r.has_embedding, r.match_count, r.status, r.visibility;
    RAISE NOTICE 'tenant    : %', r.tenant_id;
    RAISE NOTICE 'payload   : %', r.kind_payload::text;
  END LOOP;

  RAISE NOTICE '=== Intent matches between any two of those intents ===';
  FOR r IN
    SELECT m.match_id, m.intent_a_id, m.intent_b_id,
           m.vitana_id_a, m.vitana_id_b, m.kind_pairing, m.score, m.match_reasons, m.state, m.created_at
      FROM public.intent_matches m
     WHERE m.created_at > now() - interval '7 days'
       AND (
         m.intent_a_id IN (SELECT intent_id FROM public.user_intents WHERE category LIKE 'dance.%' OR intent_kind IN ('activity_seek','learning_seek','mentor_seek'))
         OR
         m.intent_b_id IN (SELECT intent_id FROM public.user_intents WHERE category LIKE 'dance.%' OR intent_kind IN ('activity_seek','learning_seek','mentor_seek'))
       )
     ORDER BY m.created_at DESC
     LIMIT 20
  LOOP
    RAISE NOTICE 'match: % → %     score=% pairing=% state=%', r.vitana_id_a, COALESCE(r.vitana_id_b, '<external>'), r.score, r.kind_pairing, r.state;
    RAISE NOTICE '  reasons: %', r.match_reasons::text;
  END LOOP;
END;
$$;
