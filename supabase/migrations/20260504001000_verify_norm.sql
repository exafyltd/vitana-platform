DO $$
DECLARE r1 text; r2 text; r3 text;
BEGIN
  r1 := public.vitana_id_normalize_token('dragan one');
  r2 := public.vitana_id_normalize_token('dragan 1');
  r3 := public.vitana_id_normalize_token('@DRAGAN one');
  RAISE NOTICE 'normalize("dragan one") = %', r1;
  RAISE NOTICE 'normalize("dragan 1")   = %', r2;
  RAISE NOTICE 'normalize("@DRAGAN one") = %', r3;
END;
$$;
