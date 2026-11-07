-- VTID-05573 rollback of 20261102052000 (run LAST, after rollback-052300). Unfreezes the six frozen tables (the four legacy tables
-- and the two participant tables): restores INSERT/UPDATE/DELETE/TRUNCATE to exactly the grantees that held them before the freeze
-- (anon, authenticated, service_role and PUBLIC, whichever did), read from the `pre-freeze-acl=` note that 20261102052000 wrote on
-- each bak_* table. A snapshot without that note falls back to the Supabase default (anon, authenticated, service_role). Row
-- access stays decided by RLS; the restored legacy tables have RLS on and no member policy until the v1 chain is replayed.
-- The bak_* snapshots are KEPT: they are dropped only by a later owner-approved step after their 30-day retention.
BEGIN;
DO $rb$
DECLARE
  v_t text;
  v_note text;
  v_acl aclitem[];
  v_g record;
  v_owner oid;
BEGIN
  FOREACH v_t IN ARRAY ARRAY['messages', 'message_threads', 'global_message_threads', 'global_messages',
                             'thread_participants', 'global_thread_participants'] LOOP
    IF to_regclass('public.' || v_t) IS NULL THEN
      CONTINUE;
    END IF;
    v_note := CASE WHEN to_regclass('public.bak_' || v_t) IS NULL THEN NULL
                   ELSE substring(obj_description(to_regclass('public.bak_' || v_t), 'pg_class') from 'pre-freeze-acl=(\S+)$') END;
    SELECT c.relowner INTO v_owner FROM pg_class c WHERE c.oid = to_regclass('public.' || v_t);
    IF v_note IS NULL THEN
      EXECUTE format('GRANT INSERT, UPDATE, DELETE, TRUNCATE ON public.%I TO anon, authenticated, service_role', v_t);
    ELSIF v_note <> 'NULL' THEN
      v_acl := v_note::aclitem[];
      FOR v_g IN
        SELECT DISTINCT a.grantee, a.privilege_type FROM aclexplode(v_acl) a
         WHERE a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE') AND a.grantee <> v_owner
      LOOP
        EXECUTE format('GRANT %s ON public.%I TO %s', v_g.privilege_type, v_t,
          CASE WHEN v_g.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(v_g.grantee)) END);
      END LOOP;
    END IF;
  END LOOP;
END
$rb$;
COMMIT;
