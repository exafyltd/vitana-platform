-- Read-only verification: print first 5 re-minted vitana_ids
DO $verify$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.vitana_id, p.registration_seq, u.created_at
      FROM public.profiles p JOIN auth.users u ON u.id = p.user_id
     ORDER BY p.registration_seq ASC NULLS LAST LIMIT 5
  LOOP
    RAISE NOTICE 'seq=% vitana_id=% created_at=%', r.registration_seq, r.vitana_id, r.created_at;
  END LOOP;

  RAISE NOTICE '--- sequence current ---';
  RAISE NOTICE 'vitana_id_seq nextval would be: %', (SELECT last_value FROM public.vitana_id_seq);

  RAISE NOTICE '--- aliases parked ---';
  RAISE NOTICE 'handle_aliases count: %', (SELECT count(*) FROM public.handle_aliases);

  RAISE NOTICE '--- profiles vs app_users mirror drift ---';
  RAISE NOTICE 'rows where mirror disagrees: %', (
    SELECT count(*) FROM public.app_users a
      JOIN public.profiles p USING (user_id)
     WHERE a.vitana_id IS DISTINCT FROM p.vitana_id
  );

  RAISE NOTICE '--- snapshot health ---';
  RAISE NOTICE 'chat_messages with stale sender_vitana_id: %', (
    SELECT count(*) FROM public.chat_messages cm
      JOIN public.profiles p ON p.user_id = cm.sender_id
     WHERE cm.sender_vitana_id IS DISTINCT FROM p.vitana_id
  );
END;
$verify$;
