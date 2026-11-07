-- VTID-05572 (mt-data-cleanup-r2 / profiles-tenant-backfill, task P1): run the profiles.tenant_id backfill.
-- Applies after 20261102042000_vtid_05572_profiles_tenant_backfill_fn.sql, through RUN-MIGRATION.yml only, after the
-- owner approves the file and the target database (collaboration.md §7d). Nothing is applied from the PR.
-- Takes the snapshot first (inside mt_profiles_tenant_backfill_run), then sets profiles.tenant_id for members with
-- exactly one membership; members with 0 or 2+ memberships stay NULL and are listed in
-- legacy_archive.mt_profiles_tenant_unresolved. The column stays nullable. Never defaults anyone to Maxina.
-- Rollback (pre-approved, run only through RUN-MIGRATION after owner approval):
-- docs/validation/VTID-05572/rollback-042100-profiles-tenant-backfill.sql
-- Idempotent: a second run snapshots nothing new (first capture wins) and sets nothing.

-- impact-allow-solo-migration: data backfill into an existing nullable column; no code reads anything new.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '300s';

DO $apply$
DECLARE
  v_res     jsonb;
  v_bad     bigint;
  v_missed  bigint;
BEGIN
  v_res := public.mt_profiles_tenant_backfill_run();
  RAISE NOTICE 'VTID-05572 profiles.tenant_id backfill: %', v_res;

  -- Every profile the backfill set holds exactly its single membership tenant (never anything else, never Maxina).
  SELECT count(*) INTO v_bad
    FROM legacy_archive.mt_profiles_tenant_backfill_log l
    JOIN public.profiles p ON p.user_id = l.user_id
   WHERE p.tenant_id IS DISTINCT FROM l.tenant_id
      OR (SELECT count(*) FROM public.user_tenants ut WHERE ut.user_id = l.user_id) <> 1
      OR NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = l.user_id AND ut.tenant_id = p.tenant_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'VTID-05572: % backfilled profiles do not hold their single membership tenant', v_bad;
  END IF;

  -- Nobody with exactly one membership (and not a bot/service account) is left NULL.
  SELECT count(*) INTO v_missed
    FROM public.profiles p
   WHERE p.tenant_id IS NULL
     AND p.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = p.user_id)
     AND (SELECT count(*) FROM public.user_tenants ut WHERE ut.user_id = p.user_id) = 1
     AND EXISTS (SELECT 1 FROM public.tenants t
                  WHERE t.id = (SELECT ut.tenant_id FROM public.user_tenants ut WHERE ut.user_id = p.user_id));
  IF v_missed > 0 THEN
    RAISE EXCEPTION 'VTID-05572: % single-membership profiles are still NULL', v_missed;
  END IF;
END
$apply$;

COMMIT;
