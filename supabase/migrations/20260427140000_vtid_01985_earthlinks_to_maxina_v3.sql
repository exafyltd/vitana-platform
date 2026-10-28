-- VTID-01985 (v3): tenant cleanup — also skip views.
--
-- v2 dropped 16 admin_insights rows successfully but then aborted on
-- public.admin_tenant_analytics, which is a VIEW (cannot UPDATE).
-- The information_schema.columns scan picked up views that expose a
-- tenant_id column; v3 restricts to base tables only by joining
-- information_schema.tables and filtering on table_type='BASE TABLE'.
--
-- Same exception-recovery strategy as v2: on any constraint violation
-- during UPDATE, DELETE the Earthlinks rows.

BEGIN;

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE tenant_id = '6d82cfc3-a718-432d-9656-c9eb83bb8322') THEN
    RAISE EXCEPTION 'Earthlinks tenant 6d82cfc3-... not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE tenant_id = '2e7528b8-472a-4356-88da-0280d4639cce') THEN
    RAISE EXCEPTION 'Maxina tenant 2e7528b8-... not found';
  END IF;
END
$check$;

-- ============================================================================
-- Step 1: Migrate or drop every Earthlinks row in public.* (BASE TABLES only)
-- ============================================================================

DO $migrate$
DECLARE
  r RECORD;
  v_count BIGINT;
  v_total_migrated BIGINT := 0;
  v_total_dropped BIGINT := 0;
BEGIN
  FOR r IN
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.column_name = 'tenant_id'
      AND c.table_schema = 'public'
      AND c.table_name <> 'tenants'
      AND t.table_type = 'BASE TABLE'   -- skip views
    ORDER BY c.table_name
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
        BEGIN
          EXECUTE format(
            'DELETE FROM %I.%I WHERE tenant_id = %L::uuid',
            r.table_schema, r.table_name,
            '6d82cfc3-a718-432d-9656-c9eb83bb8322'
          );
          GET DIAGNOSTICS v_count = ROW_COUNT;
          RAISE NOTICE 'CONFLICT in %.% (sqlstate=%) — DROPPED % Earthlinks rows',
            r.table_schema, r.table_name, SQLSTATE, v_count;
          v_total_dropped := v_total_dropped + v_count;
        EXCEPTION
          WHEN OTHERS THEN
            RAISE NOTICE 'COULD NOT DELETE in %.% — sqlstate=%, msg=%',
              r.table_schema, r.table_name, SQLSTATE, SQLERRM;
        END;
    END;
  END LOOP;
  RAISE NOTICE 'STEP 1 SUMMARY — migrated: %, dropped (conflicts): %',
    v_total_migrated, v_total_dropped;
END
$migrate$;

-- ============================================================================
-- Step 2: auth.users metadata
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
SELECT 'STEP 2: auth.users active_tenant_id flipped: ' || count(*)::text AS step2_summary
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
SELECT 'STEP 2b: auth.users tenant_slug flipped: ' || count(*)::text AS step2b_summary
FROM updated;

-- ============================================================================
-- Step 3: Delete Earthlings (with G) placeholder
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
    SELECT c.table_schema, c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.column_name = 'tenant_id'
      AND c.table_schema = 'public'
      AND c.table_name <> 'tenants'
      AND t.table_type = 'BASE TABLE'
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

SELECT 'Remaining tenants:' AS report;
SELECT tenant_id, name, slug, is_active FROM public.tenants ORDER BY name;

COMMIT;
