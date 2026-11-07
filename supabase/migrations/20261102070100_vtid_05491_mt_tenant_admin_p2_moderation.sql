-- VTID-05491 (mt-tenant-admin-r2/tenant-admin-moderation-db) P2: tenant ownership of moderation rows. EXPAND ONLY.
--
-- Today (vitana-v1 20251010065205, 20260622120000_vtid_03319_phase1_moderation.sql) content_reports and moderation_actions
-- carry no tenant, and is_community_moderator() is true for a staff/admin membership in ANY tenant, so a moderator of one
-- community reads and updates every community's reports. This migration only adds the data the later files need; no
-- policy, grant or existing function is changed here, so nothing a caller can observe changes except the new columns.
--
--   * content_reports.tenant_id, moderation_actions.tenant_id (uuid, NULL allowed, FK to tenants ON DELETE SET NULL).
--   * Snapshot first: legacy_archive.bak_05491_content_reports / bak_05491_moderation_actions (taken once, never replaced).
--   * Backfill, never guessing: a report takes its reporter's tenant only when that is unambiguous (the reporter's primary
--     membership, or the only one) - never the oldest tenant. An audit row takes the tenant of its target (a profile_post
--     with a tenant_id, or a user with an unambiguous tenant). Everything else stays NULL; NULL is visible to exafy_admin only
--     once the scope policies (20261102070600) are on.
--   * public.moderation_home_tenant(user) - internal helper (SECURITY DEFINER, EXECUTE revoked from PUBLIC/anon/authenticated).
--   * public.is_tenant_moderator(tenant) - exafy_admin claim, or an active staff/admin membership IN THAT TENANT. NULL tenant
--     is exafy_admin only.
--   * BEFORE INSERT trigger on content_reports: a NULL tenant_id is stamped from the reporter's home tenant; a given tenant_id
--     must be one the reporter is a member of (TENANT_NOT_MEMBER), which also closes a client-supplied tenant_id.
--
-- Safe to re-run. lock_timeout 3s with up to 5 retries on lock_not_available.
-- Rollback: docs/validation/VTID-05491/rollback-070100-p2-moderation.sql. Order: docs/multitenancy/MIGRATION-QUEUE.md.
-- Applied later by RUN-MIGRATION only after the owner approves the file and the target database (collaboration.md 7d).

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.content_reports') IS NULL THEN RAISE EXCEPTION 'VTID-05491 P2: public.content_reports is missing'; END IF;
  IF to_regclass('public.moderation_actions') IS NULL THEN RAISE EXCEPTION 'VTID-05491 P2: public.moderation_actions is missing'; END IF;
  IF to_regclass('public.memberships') IS NULL THEN RAISE EXCEPTION 'VTID-05491 P2: public.memberships is missing'; END IF;
  IF to_regclass('public.user_tenants') IS NULL THEN RAISE EXCEPTION 'VTID-05491 P2: public.user_tenants is missing'; END IF;
  IF to_regclass('public.tenants') IS NULL THEN RAISE EXCEPTION 'VTID-05491 P2: public.tenants is missing'; END IF;
END
$guard$;

DO $mig$
DECLARE
  v_try int := 0;
  v_key text;
BEGIN
  -- The live tenants key is tenants(tenant_id) (VTID-04716); a fresh local stack built from the bootstrap has tenants(id).
  SELECT c.column_name INTO v_key
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'tenants' AND c.column_name IN ('tenant_id', 'id')
   ORDER BY (c.column_name = 'tenant_id') DESC
   LIMIT 1;
  IF v_key IS NULL THEN RAISE EXCEPTION 'VTID-05491 P2: public.tenants has neither tenant_id nor id'; END IF;

  LOOP
    v_try := v_try + 1;
    BEGIN
      SET LOCAL lock_timeout = '3s';

      -- Snapshot before any data move (taken once; a re-run keeps the original).
      CREATE SCHEMA IF NOT EXISTS legacy_archive;
      CREATE TABLE IF NOT EXISTS legacy_archive.bak_05491_content_reports AS
        SELECT r.*, now() AS captured_at FROM public.content_reports r;
      CREATE TABLE IF NOT EXISTS legacy_archive.bak_05491_moderation_actions AS
        SELECT a.*, now() AS captured_at FROM public.moderation_actions a;

      ALTER TABLE public.content_reports ADD COLUMN IF NOT EXISTS tenant_id uuid;
      ALTER TABLE public.moderation_actions ADD COLUMN IF NOT EXISTS tenant_id uuid;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_reports_tenant_fkey'
                        AND conrelid = 'public.content_reports'::regclass) THEN
        EXECUTE format('ALTER TABLE public.content_reports ADD CONSTRAINT content_reports_tenant_fkey '
                       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(%I) ON DELETE SET NULL', v_key);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'moderation_actions_tenant_fkey'
                        AND conrelid = 'public.moderation_actions'::regclass) THEN
        EXECUTE format('ALTER TABLE public.moderation_actions ADD CONSTRAINT moderation_actions_tenant_fkey '
                       'FOREIGN KEY (tenant_id) REFERENCES public.tenants(%I) ON DELETE SET NULL', v_key);
      END IF;

      CREATE INDEX IF NOT EXISTS idx_content_reports_tenant_status
        ON public.content_reports (tenant_id, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_moderation_actions_tenant_created
        ON public.moderation_actions (tenant_id, created_at DESC);

      -- Home tenant of a user: the primary membership, else the only one, else NULL. Never "the oldest".
      CREATE OR REPLACE FUNCTION public.moderation_home_tenant(p_user_id uuid)
      RETURNS uuid
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public, pg_catalog
      AS $fn$
        SELECT ut.tenant_id
          FROM public.user_tenants ut
         WHERE ut.user_id = p_user_id
           AND (ut.is_primary
                OR (SELECT count(*) FROM public.user_tenants x WHERE x.user_id = ut.user_id) = 1)
         ORDER BY ut.is_primary DESC
         LIMIT 1
      $fn$;
      REVOKE ALL ON FUNCTION public.moderation_home_tenant(uuid) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION public.moderation_home_tenant(uuid) TO service_role;

      CREATE OR REPLACE FUNCTION public.is_tenant_moderator(p_tenant_id uuid)
      RETURNS boolean
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = public, pg_catalog
      AS $fn$
        SELECT coalesce(((auth.jwt() -> 'app_metadata' ->> 'exafy_admin'))::boolean, false)
            OR (p_tenant_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM public.memberships m
                             WHERE m.user_id = auth.uid()
                               AND m.tenant_id = p_tenant_id
                               AND m.role::text IN ('staff', 'admin')
                               AND m.status = 'active'))
      $fn$;
      REVOKE ALL ON FUNCTION public.is_tenant_moderator(uuid) FROM PUBLIC, anon;
      GRANT EXECUTE ON FUNCTION public.is_tenant_moderator(uuid) TO authenticated, service_role;

      COMMENT ON FUNCTION public.is_tenant_moderator(uuid) IS
        'VTID-05491: exafy_admin claim, or an active staff/admin membership in p_tenant_id. NULL tenant: exafy_admin only.';

      -- Stamp / validate the tenant of a new report.
      CREATE OR REPLACE FUNCTION public.content_reports_stamp_tenant()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = public, pg_catalog
      AS $fn$
      BEGIN
        IF NEW.tenant_id IS NULL THEN
          NEW.tenant_id := public.moderation_home_tenant(NEW.reporter_user_id);
        ELSIF NOT EXISTS (SELECT 1 FROM public.user_tenants ut
                           WHERE ut.tenant_id = NEW.tenant_id AND ut.user_id = NEW.reporter_user_id) THEN
          RAISE EXCEPTION 'TENANT_NOT_MEMBER';
        END IF;
        RETURN NEW;
      END
      $fn$;
      REVOKE ALL ON FUNCTION public.content_reports_stamp_tenant() FROM PUBLIC, anon, authenticated;

      DROP TRIGGER IF EXISTS trg_content_reports_stamp_tenant ON public.content_reports;
      CREATE TRIGGER trg_content_reports_stamp_tenant
        BEFORE INSERT ON public.content_reports
        FOR EACH ROW EXECUTE FUNCTION public.content_reports_stamp_tenant();

      -- Backfill (only rows still NULL, so a re-run changes nothing).
      UPDATE public.content_reports r
         SET tenant_id = public.moderation_home_tenant(r.reporter_user_id)
       WHERE r.tenant_id IS NULL;

      UPDATE public.moderation_actions a
         SET tenant_id = public.moderation_home_tenant(a.target_id)
       WHERE a.tenant_id IS NULL AND a.target_type = 'user' AND a.target_id IS NOT NULL;

      IF to_regclass('public.profile_posts') IS NOT NULL
         AND EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_schema = 'public' AND table_name = 'profile_posts' AND column_name = 'tenant_id') THEN
        UPDATE public.moderation_actions a
           SET tenant_id = p.tenant_id
          FROM public.profile_posts p
         WHERE a.tenant_id IS NULL AND a.target_type = 'profile_post' AND p.id = a.target_id;
      END IF;

      COMMENT ON COLUMN public.content_reports.tenant_id IS
        'VTID-05491: tenant of the report (reporter home tenant at insert). NULL = unknown, visible to exafy_admin only under the scope policies.';
      COMMENT ON COLUMN public.moderation_actions.tenant_id IS
        'VTID-05491: tenant the moderation action applied to. NULL = unknown / legacy.';

      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF v_try >= 5 THEN RAISE; END IF;
      RAISE NOTICE 'VTID-05491 P2: lock timeout, retry % of 5', v_try;
      PERFORM pg_sleep(v_try);
    END;
  END LOOP;
END
$mig$;

COMMIT;
