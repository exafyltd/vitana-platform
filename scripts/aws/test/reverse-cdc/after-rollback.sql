DO $$ DECLARE n integer; BEGIN
  SELECT count(*) INTO n FROM (
    (SELECT relname, tgname, e FROM public.state_before EXCEPT SELECT c.relname, t.tgname, t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid)
    UNION ALL
    (SELECT c.relname, t.tgname, t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid EXCEPT SELECT relname, tgname, e FROM public.state_before)) d;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: % trigger states differ from before the window', n; END IF;
  RAISE NOTICE 'ok: rollback restored every trigger state exactly (O, D and A)';
END $$;
INSERT INTO public.chat_messages (content) VALUES ('after rollback');
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_notifications WHERE body = 'msg after rollback') THEN RAISE EXCEPTION 'FAIL: notification trigger not back'; END IF;
  RAISE NOTICE 'ok: notifications fire again after rollback';
END $$;
