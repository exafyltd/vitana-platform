-- VTID-05582 rollback of 20261102051100: give authenticated/anon-less clients their INSERT/UPDATE back (the live grants,
-- scripts/aws/aurora-cutover-restore-grants.sql:1664,3058) and drop both RPCs. Apply BEFORE rollback-051000.
-- Local/staging-approved only through RUN-MIGRATION (collaboration.md section 7d); never run from a session tool.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.request_connection(uuid, text, text);
DROP FUNCTION IF EXISTS public.respond_connection(uuid, boolean);
DO $rb$
BEGIN
  IF to_regclass('public.connection_requests') IS NOT NULL THEN
    GRANT INSERT, UPDATE ON TABLE public.connection_requests TO authenticated;
  END IF;
END
$rb$;
COMMIT;
