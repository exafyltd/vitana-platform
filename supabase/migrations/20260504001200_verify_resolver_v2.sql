-- Probe: from e2etest33's perspective, call resolve_recipient_candidates
-- with both "dragan one" and "dragan1".
DO $$
DECLARE
  r record;
  v_e2e_uid uuid;
  rows_one int := 0;
  rows_dig int := 0;
  global_fl boolean;
BEGIN
  SELECT user_id INTO v_e2e_uid FROM public.profiles WHERE vitana_id = 'e2etest33';
  RAISE NOTICE 'e2etest33 user_id = %', v_e2e_uid;

  -- Test peer-scoped first (this matches the gateway call).
  FOR global_fl IN SELECT unnest(ARRAY[false, true])
  LOOP
    rows_one := 0;
    FOR r IN SELECT * FROM public.resolve_recipient_candidates(v_e2e_uid, 'dragan one', 5, global_fl) LOOP
      rows_one := rows_one + 1;
      RAISE NOTICE '  global=%: "dragan one" -> vitana_id=% score=% reason=%', global_fl, r.vitana_id, r.score, r.reason;
    END LOOP;
    RAISE NOTICE 'global=% "dragan one" total rows=%', global_fl, rows_one;

    rows_dig := 0;
    FOR r IN SELECT * FROM public.resolve_recipient_candidates(v_e2e_uid, 'dragan1', 5, global_fl) LOOP
      rows_dig := rows_dig + 1;
      RAISE NOTICE '  global=%: "dragan1" -> vitana_id=% score=% reason=%', global_fl, r.vitana_id, r.score, r.reason;
    END LOOP;
    RAISE NOTICE 'global=% "dragan1" total rows=%', global_fl, rows_dig;
  END LOOP;
END;
$$;
