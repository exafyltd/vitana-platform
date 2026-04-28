-- Probe: dump the deployed resolve_recipient_candidates body to confirm
-- whether the v2 wrapper is actually in place.
DO $$
DECLARE
  v_src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'resolve_recipient_candidates' AND n.nspname = 'public'
   LIMIT 1;

  RAISE NOTICE 'Function source first 600 chars:';
  RAISE NOTICE '%', LEFT(v_src, 600);
  RAISE NOTICE 'Contains vitana_id_normalize_token? %', (v_src LIKE '%vitana_id_normalize_token%');
END;
$$;
