-- VTID-01985: tenant cleanup
--
-- (1) Migrate every public.* row tagged with the Earthlinks tenant
--     (6d82cfc3-a718-432d-9656-c9eb83bb8322) to Maxina
--     (2e7528b8-472a-4356-88da-0280d4639cce). Earthlinks is being
--     retired; every active user belongs to Maxina.
--     The 14 Earthlinks users have ZERO overlap with Maxina (verified
--     before migration), so no PK/UNIQUE conflicts on (tenant_id,
--     user_id) keys are expected.
--
-- (2) Update auth.users.app_metadata.active_tenant_id to Maxina for
--     those 14 users so future JWTs carry the right tenant. The
--     gateway middleware reads JWT first and only falls back to
--     user_tenants when JWT is empty, so this step is required.
--
-- (3) DELETE the empty placeholder tenant "Earthlings" (with G)
--     id 33333333-3333-3333-3333-333333333333, slug 'earthlings'.
--     User confirmed this is a bug — never used, no rows in any
--     tenant-scoped table.
--
-- (4) DELETE the now-empty Earthlinks tenant row.
--
-- All in one transaction. On any constraint violation the whole
-- migration aborts and nothing changes.

BEGIN;

-- Sanity check: ensure both source and target tenants exist now
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE tenant_id = '6d82cfc3-a718-432d-9656-c9eb83bb8322') THEN
    RAISE EXCEPTION 'Earthlinks tenant 6d82cfc3-... not found — already migrated?';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce') THEN
    RAISE EXCEPTION 'Maxina tenant 2e7528b8-... not found — cannot migrate to a missing target';
  END IF;
END
$check$;

-- ============================================================================
-- Step 1: Re-tag all public.* rows from Earthlinks → Maxina
-- ============================================================================

DO $migrate$
DECLARE
  r RECORD;
  v_count BIGINT;
  v_total BIGINT := 0;
BEGIN
  FOR r IN
    SELECT table_schema, table_name
    FROM information_schema.columns
    WHERE column_name = 'tenant_id'
      AND table_schema = 'public'
      AND table_name <> 'tenants'  -- skip the tenants table itself (PK conflict)
    ORDER BY table_name
  LOOP
    EXECUTE format(
      'UPDATE %I.%I SET tenant_id = %L::uuid WHERE tenant_id = %L::uuid',
      r.table_schema, r.table_name,
      '2e7528b8-472a-4356-88da-0280d4639cce',
      '6d82cfc3-a718-432d-9656-c9eb83bb8322'
    );
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
      RAISE NOTICE 'migrated % rows in %.%', v_count, r.table_schema, r.table_name;
      v_total := v_total + v_count;
    END IF;
  END LOOP;
  RAISE NOTICE 'STEP 1 TOTAL rows migrated from Earthlinks to Maxina: %', v_total;
END
$migrate$;

-- ============================================================================
-- Step 2: Update auth.users.app_metadata.active_tenant_id for affected users
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
SELECT 'STEP 2: auth.users with active_tenant_id flipped to Maxina: ' || count(*)::text AS step2_summary
FROM updated;

-- Also fix user_metadata.tenant_slug if any user has 'earthlinks' there
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
SELECT 'STEP 2b: auth.users with tenant_slug flipped earthlinks→maxina: ' || count(*)::text AS step2b_summary
FROM updated;

-- ============================================================================
-- Step 3: DELETE the Earthlings (with G) placeholder tenant
-- ============================================================================

DELETE FROM public.tenants
WHERE tenant_id = '33333333-3333-3333-3333-333333333333';

-- ============================================================================
-- Step 4: DELETE the now-empty Earthlinks tenant
-- ============================================================================

-- Final safety check: refuse to delete Earthlinks if any public.* row still
-- references it (means migration step 1 missed a table).
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
-- Step 5: Final state report
-- ============================================================================

SELECT 'Remaining tenants:' AS report;
SELECT tenant_id, name, slug, is_active FROM public.tenants ORDER BY name;

COMMIT;
