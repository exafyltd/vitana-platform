-- Run after supabase-cutover-reverse-cdc-triggers.sql (applied twice).
DO $$ DECLARE n integer; BEGIN
  SELECT count(*) INTO n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgenabled <> 'D';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: % public user triggers still enabled', n; END IF;
  SELECT count(*) INTO n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relname = 'chat_reads' AND t.tgisinternal AND t.tgenabled <> 'O';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: internal FK triggers were touched'; END IF;
  IF (SELECT t.tgenabled FROM pg_trigger t WHERE t.tgname = 'other_trg') <> 'O' THEN RAISE EXCEPTION 'FAIL: non-public trigger touched'; END IF;
  IF (SELECT tgenabled FROM vtid_05023_backup.trigger_state_snapshot WHERE trigger_name = 'always_on') <> 'A'
     OR (SELECT tgenabled FROM vtid_05023_backup.trigger_state_snapshot WHERE trigger_name = 'trg_notify_chat_message') <> 'O'
     OR (SELECT tgenabled FROM vtid_05023_backup.trigger_state_snapshot WHERE trigger_name = 'was_disabled') <> 'D' THEN
    RAISE EXCEPTION 'FAIL: snapshot does not hold the original states (re-run overwrote it?)';
  END IF;
  RAISE NOTICE 'ok: every public user trigger disabled, FK and non-public triggers untouched, snapshot kept';
END $$;
-- A row arriving the way DMS applies it (plain INSERT/UPDATE as the table owner): no notification.
INSERT INTO public.chat_messages (content) VALUES ('replicated');
INSERT INTO public.voucher_orders (id, updated_at) VALUES (1, '2026-01-01');
UPDATE public.voucher_orders SET updated_at = '2026-01-02' WHERE id = 1;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.user_notifications) THEN RAISE EXCEPTION 'FAIL: a replicated chat message notified'; END IF;
  IF (SELECT updated_at FROM public.voucher_orders WHERE id = 1) <> '2026-01-02' THEN RAISE EXCEPTION 'FAIL: updated_at trigger overwrote the replicated value'; END IF;
  RAISE NOTICE 'ok: replicated rows fire no trigger and keep their values';
END $$;
