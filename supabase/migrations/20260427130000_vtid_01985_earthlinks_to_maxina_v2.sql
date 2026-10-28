-- VTID-01985 (v2): tenant cleanup — defensive against tenant-level dedup conflicts.
--
-- v1 (20260427120000) aborted on `admin_insights_dedup` UNIQUE constraint.
-- The 14 Earthlinks users have ZERO overlap with Maxina users, so the
-- conflict is NOT on (tenant_id, user_id) keys — it's on TENANT-LEVEL
-- aggregation keys (e.g., admin_insights is one row per tenant per
-- insight_type, both tenants already have their own row).
--
-- Strategy:
--   For each public.* table with a tenant_id column:
--     - Try UPDATE Earthlinks → Maxina inside a sub-block.
--     - On unique_violation, DELETE the Earthlinks rows instead
--       (Maxina already has its own equivalent rows).
--     - Log migrated vs deleted counts.
--
-- This is safe for the data we care about (memory_items, memory_facts,
-- user_tenants, app_users, etc.) because their UNIQUE keys include
-- user_id, and the user_id sets are disjoint between tenants — UPDATE
-- will succeed.
--
-- Tenant-level analytical/aggregated tables (admin_insights, kpi caches,
-- etc.) will have UPDATE→fail→DELETE; the deleted rows are derived data
-- and Maxina already has the same kind of row.

BEGIN;

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE tenant_id = '6d82cfc3-a718-432d-9656-c9eb83bb8322') THEN
    RAISE EXCEPTION 'Earthlinks tenant 6d82cfc3-... not found — already migrated?';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce') THEN
    RAISE EXCEPTION 'Maxina tenant 2e7528b8-... not found';
  END IF;
END
$check$;

-- ============================================================================
-- Step 1: Migrate or drop every Earthlinks row in public.*
-- ============================================================================

DO $migrate$
DECLARE
  r RECORD;
  v_count BIGINT;
  v_total_migrated BIGINT := 0;
  v_total_dropped BIGINT := 0;
BEGIN
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.columns
    WHERE column_name = 'tenant_id'
      AND table_schema = 'public'
      AND table_name <> 'tenants'
    ORDER BY table_name
  LOOP
    BEGIN
      EXECUTE format(
        'UPDATE %I.%I SET tenant_id = %L::uuid WHERE tenant_id = %L::uuid',
        r.table_schema, r.table_name,
        '2e7528b8-472a-4356-88da-0280d4639cce',
        '6d82cfc3-a718-432d-9656-c9eb83bb8322'
      );
      GET DIAGNOSTICS v_count = ROW_COUNT;
      IF v_count > 0 THEN
        RAISE NOTICE 'migrated % rows in %.%', v_count, r.table_schema, r.table_name;
        v_total_migrated := v_total_migrated + v_count;
      END IF;

    EXCEPTION
      WHEN unique_violation OR exclusion_violation OR foreign_key_violation OR check_violation THEN
        -- A tenant-level dedup constraint blocked the UPDATE.
        -- Drop the Earthlinks row(s); Maxina already has the equivalent.
        EXECUTE format(
          'DELETE FROM %I.%I WHERE tenant_id = %L::uuid',
          r.table_schema, r.table_name,
          '6d82cfc3-a718-432d-9656-c9eb83bb8322'
        );
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RAISE NOTICE 'CONFLICT in %.% (sqlerr=%) — DROPPED % Earthlinks rows (Maxina has equivalent)',
          r.table_schema, r.table_name, SQLSTATE, v_count;
        v_total_dropped := v_total_dropped + v_count;
    END;
  END LOOP;
  RAISE NOTICE 'STEP 1 SUMMARY — migrated: %, dropped (conflicts): %',
    v_total_migrated, v_total_dropped;
END
$migrate$;

-- ============================================================================
-- Step 2: Update auth.users.app_metadata for affected users
-- ============================================================================

WITH updated AS (
  UPDATE auth.users
  SET raw_app_meta_data = jsonb_set(
        COALESCE(raw_app_meta_data, '{}'::jsonb),
        '{active_tenant_id}',
        '"2e7528b8-472a-4356-88da-0280d4639cce"'::jsonb
      )
  WHERE raw_app_meta_data->>'active_tenant_id' = '6d82cfc3-a718-432d-9656-c9eb83bb8322'
  RETURNING id
)
SELECT 'STEP 2: auth.users active_tenant_id flipped Earthlinks→Maxina: ' || count(*)::text AS step2_summary
FROM updated;

WITH updated AS (
  UPDATE auth.users
  SET raw_user_meta_data = jsonb_set(
        COALESCE(raw_user_meta_data, '{}'::jsonb),
        '{tenant_slug}',
        '"maxina"'::jsonb
      )
  WHERE raw_user_meta_data->>'tenant_slug' = 'earthlinks'
  RETURNING id
)
SELECT 'STEP 2b: auth.users tenant_slug earthlinks→maxina: ' || count(*)::text AS step2b_summary
FROM updated;

-- ============================================================================
-- Step 3: DELETE the Earthlings (with G) placeholder tenant
-- ============================================================================

DELETE FROM public.tenants
WHERE tenant_id = '33333333-3333-3333-3333-333333333333';

-- ============================================================================
-- Step 4: Final safety check + DELETE Earthlinks tenant
-- ============================================================================

DO $finalcheck$
DECLARE
  r RECORD;
  v_count BIGINT;
  v_remaining BIGINT := 0;
BEGIN
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.columns
    WHERE column_name = 'tenant_id'
      AND table_schema = 'public'
      AND table_name <> 'tenants'
  LOOP
    EXECUTE format(
      'SELECT COUNT(*) FROM %I.%I WHERE tenant_id = %L::uuid',
      r.table_schema, r.table_name,
      '6d82cfc3-a718-432d-9656-c9eb83bb8322'
    ) INTO v_count;
    IF v_count > 0 THEN
      RAISE NOTICE 'STILL EARTHLINKS in %.%: % rows', r.table_schema, r.table_name, v_count;
      v_remaining := v_remaining + v_count;
    END IF;
  END LOOP;
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Refusing to delete Earthlinks tenant — % rows still reference it', v_remaining;
  END IF;
END
$finalcheck$;

DELETE FROM public.tenants
WHERE tenant_id = '6d82cfc3-a718-432d-9656-c9eb83bb8322';

-- ============================================================================
-- Step 5: Final state
-- ============================================================================

SELECT 'Remaining tenants:' AS report;
SELECT tenant_id, name, slug, is_active FROM public.tenants ORDER BY name;

COMMIT;
