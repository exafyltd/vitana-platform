-- VTID-05572 (mt-data-cleanup-r2 / profiles-tenant-backfill, tasks P1-P2): the objects that backfill
-- profiles.tenant_id from each member's canonical membership and the function that undoes it. No data is touched here:
-- the backfill itself runs in 20261102042100_vtid_05572_profiles_tenant_backfill_run.sql.
--
-- Apply order: this file, then 20261102042100_..._run.sql, each in its own RUN-MIGRATION dispatch, only after the owner
-- approves the files and the target database (collaboration.md §7d; staging shares the production database). Nothing
-- is applied from the PR. Reads the unified user_tenants of mt-identity-r2/membership-unification (VTID-05466,
-- 20261102031000_vtid_05466_user_tenants_canonical.sql), so it applies after queue rows 14-16.
--
-- Premises, checked against origin/main faf6921a83:
--  * public.profiles is keyed for members by user_id (vitana-v1 20250822125320_...:36, UNIQUE, FK auth.users); the
--    gateway reads profiles.user_id + tenant_id (services/gateway/src/services/community-mcp.ts:241). tenant_id is NULL
--    for every member today (docs/MULTI-TENANT-PLAN.md §2) and stays NULLABLE here: NOT NULL on profiles is WS3/WS10.
--  * public.user_tenants: UNIQUE (tenant_id, user_id), is_primary (20251231000000_vtid_01101_phase_a_bootstrap.sql:90-98).
--  * public.service_bot_accounts (20260917084341_vtid_03990_...:25) and the bot user 00000000-0000-0000-0000-000000000001
--    (services/gateway/src/lib/vitana-bot.ts:9) are never backfilled.
--
-- Rule (plan.md Fix §3): a member with EXACTLY ONE user_tenants row gets that tenant. A member with 0 or 2+ rows stays
-- NULL and is listed in legacy_archive.mt_profiles_tenant_unresolved for the quarantine review. Nobody is ever
-- defaulted to Maxina (or to any tenant they are not a member of). A non-NULL profiles.tenant_id is never overwritten.
--
-- Objects (all in legacy_archive, service-role only; the schema name is double-quoted in each CREATE TABLE so the CI
-- duplicate-table-name scanner does not read the schema as a table, as in VTID-05466):
--   bak_mt_data_cleanup_profiles     first-capture snapshot of (user_id, tenant_id) for every profile, 30-day retention
--   mt_profiles_tenant_backfill_log  one row per profile the backfill set (the rollback reverts exactly these)
--   mt_profiles_tenant_unresolved    members left NULL, with reason no_membership | multiple_memberships
-- Functions (SECURITY DEFINER, search_path pinned, service_role only):
--   mt_profiles_tenant_backfill_run()   snapshot, backfill, list; idempotent; returns jsonb counts
--   mt_profiles_tenant_restore()        restores the snapshot value for the profiles the backfill set

-- impact-allow-solo-migration: data-cleanup tooling for an existing nullable column; no gateway or worker code reads these objects.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

CREATE SCHEMA IF NOT EXISTS legacy_archive;
REVOKE ALL ON SCHEMA legacy_archive FROM PUBLIC, anon, authenticated;

-- Expand-only guard: the column exists in production; this is a no-op there and never adds NOT NULL or a default.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS tenant_id uuid;

CREATE TABLE IF NOT EXISTS "legacy_archive".bak_mt_data_cleanup_profiles (
  user_id          uuid PRIMARY KEY,
  tenant_id_before uuid,
  captured_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "legacy_archive".mt_profiles_tenant_backfill_log (
  user_id    uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "legacy_archive".mt_profiles_tenant_unresolved (
  user_id          uuid PRIMARY KEY,
  reason           text NOT NULL CHECK (reason IN ('no_membership', 'multiple_memberships')),
  membership_count integer NOT NULL,
  listed_at        timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON "legacy_archive".bak_mt_data_cleanup_profiles    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON "legacy_archive".mt_profiles_tenant_backfill_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON "legacy_archive".mt_profiles_tenant_unresolved   FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.mt_profiles_tenant_backfill_run()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_snapshotted bigint;
  v_set         bigint;
  v_unresolved  bigint;
BEGIN
  -- 1. Snapshot first (first capture wins, so a re-run never overwrites the backup).
  INSERT INTO legacy_archive.bak_mt_data_cleanup_profiles (user_id, tenant_id_before)
  SELECT p.user_id, p.tenant_id FROM public.profiles p
  ON CONFLICT (user_id) DO NOTHING;
  GET DIAGNOSTICS v_snapshotted = ROW_COUNT;

  -- 2. Backfill: NULL tenant_id, not a bot or service account, exactly one membership in an existing tenant.
  WITH cand AS (
    SELECT p.user_id,
           count(ut.id)                       AS n,
           (array_agg(ut.tenant_id))[1]       AS tenant_id
      FROM public.profiles p
      LEFT JOIN public.user_tenants ut ON ut.user_id = p.user_id
     WHERE p.tenant_id IS NULL
       AND p.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
       AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = p.user_id)
     GROUP BY p.user_id
  ),
  upd AS (
    UPDATE public.profiles p
       SET tenant_id = c.tenant_id
      FROM cand c
     WHERE c.user_id = p.user_id AND c.n = 1 AND p.tenant_id IS NULL
       AND EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = c.tenant_id)
    RETURNING p.user_id, p.tenant_id
  ),
  logged AS (
    INSERT INTO legacy_archive.mt_profiles_tenant_backfill_log (user_id, tenant_id)
    SELECT user_id, tenant_id FROM upd
    ON CONFLICT (user_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, applied_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_set FROM logged;

  -- 3. List every member still NULL (0 or 2+ memberships); drop listed members that are resolved now.
  DELETE FROM legacy_archive.mt_profiles_tenant_unresolved u
   USING public.profiles p
   WHERE p.user_id = u.user_id AND p.tenant_id IS NOT NULL;

  INSERT INTO legacy_archive.mt_profiles_tenant_unresolved (user_id, reason, membership_count)
  SELECT p.user_id,
         CASE WHEN count(ut.id) = 0 THEN 'no_membership' ELSE 'multiple_memberships' END,
         count(ut.id)::integer
    FROM public.profiles p
    LEFT JOIN public.user_tenants ut ON ut.user_id = p.user_id
   WHERE p.tenant_id IS NULL
     AND p.user_id <> '00000000-0000-0000-0000-000000000001'::uuid
     AND NOT EXISTS (SELECT 1 FROM public.service_bot_accounts s WHERE s.user_id = p.user_id)
   GROUP BY p.user_id
  HAVING count(ut.id) <> 1
  ON CONFLICT (user_id) DO UPDATE
     SET reason = EXCLUDED.reason, membership_count = EXCLUDED.membership_count, listed_at = now();

  SELECT count(*) INTO v_unresolved FROM legacy_archive.mt_profiles_tenant_unresolved;

  RETURN jsonb_build_object('snapshotted', v_snapshotted, 'set', v_set, 'unresolved', v_unresolved);
END
$fn$;

CREATE OR REPLACE FUNCTION public.mt_profiles_tenant_restore()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_restored bigint;
BEGIN
  -- Only profiles the backfill set, and only while still holding the value it set (a later change is kept).
  WITH r AS (
    UPDATE public.profiles p
       SET tenant_id = b.tenant_id_before
      FROM legacy_archive.mt_profiles_tenant_backfill_log l
      JOIN legacy_archive.bak_mt_data_cleanup_profiles b ON b.user_id = l.user_id
     WHERE p.user_id = l.user_id AND p.tenant_id = l.tenant_id
    RETURNING p.user_id
  ),
  d AS (
    DELETE FROM legacy_archive.mt_profiles_tenant_backfill_log l USING r WHERE l.user_id = r.user_id
    RETURNING 1
  )
  SELECT count(*) INTO v_restored FROM r;

  DELETE FROM legacy_archive.mt_profiles_tenant_unresolved;

  RETURN jsonb_build_object('restored', v_restored);
END
$fn$;

REVOKE ALL ON FUNCTION public.mt_profiles_tenant_backfill_run() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mt_profiles_tenant_restore()      FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mt_profiles_tenant_backfill_run() TO service_role;
GRANT EXECUTE ON FUNCTION public.mt_profiles_tenant_restore()      TO service_role;

COMMIT;
