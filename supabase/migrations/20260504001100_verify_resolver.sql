-- Probe: call resolve_recipient_candidates with both tokens and report.
DO $$
DECLARE
  r record;
  rows_one int := 0;
  rows_dig int := 0;
BEGIN
  RAISE NOTICE '=== "dragan one" with global=true ===';
  FOR r IN
    SELECT * FROM public.resolve_recipient_candidates(
      '0adc6ff6-acb0-4dca-99d0-295211a40e3e'::uuid,  -- dragan1's user_id; use as actor so we don't self-resolve
      'dragan one',
      5,
      true
    )
  LOOP
    rows_one := rows_one + 1;
    RAISE NOTICE 'candidate vitana_id=% score=% reason=%', r.vitana_id, r.score, r.reason;
  END LOOP;
  RAISE NOTICE 'rows for "dragan one" = %', rows_one;

  -- Use a different actor to actually find dragan1.
  -- e2etest33 user_id is needed; pick any non-dragan user.
  RAISE NOTICE '=== From e2etest33 perspective, "dragan one" peer-scoped ===';
  FOR r IN
    SELECT p.user_id INTO STRICT r FROM public.profiles p WHERE p.vitana_id = 'e2etest33' LIMIT 1
  LOOP
    NULL;
  END LOOP;

  -- Fetch e2etest33's user_id then call resolver.
  DECLARE
    v_e2e_uid uuid;
  BEGIN
    SELECT user_id INTO v_e2e_uid FROM public.profiles WHERE vitana_id = 'e2etest33';
    RAISE NOTICE 'e2etest33 user_id = %', v_e2e_uid;

    rows_one := 0;
    FOR r IN
      SELECT * FROM public.resolve_recipient_candidates(v_e2e_uid, 'dragan one', 5, true)
    LOOP
      rows_one := rows_one + 1;
      RAISE NOTICE '  global=true: vitana_id=% score=% reason=%', r.vitana_id, r.score, r.reason;
    END LOOP;
    RAISE NOTICE 'global=true rows=%', rows_one;

    rows_dig := 0;
    FOR r IN
      SELECT * FROM public.resolve_recipient_candidates(v_e2e_uid, 'dragan1', 5, true)
    LOOP
      rows_dig := rows_dig + 1;
      RAISE NOTICE '  global=true digit: vitana_id=% score=% reason=%', r.vitana_id, r.score, r.reason;
    END LOOP;
    RAISE NOTICE 'global=true digit rows=%', rows_dig;
  END;
END;
$$;
