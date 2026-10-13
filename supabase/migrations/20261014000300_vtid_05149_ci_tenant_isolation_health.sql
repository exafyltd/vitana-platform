-- VTID-05149 (multi-tenant M0, lane A) M3: public.ci_tenant_isolation_health().
--
-- The production tenant-isolation signal M0's exit criterion needs. Counts and
-- table names only, never row content. Called by MORNING-SYSTEM-HEALTH-CHECK.yml
-- row 21b (report-only: it never writes FAIL) over PostgREST as service_role.
--
-- Every public base table with a uuid tenant_id (except tenants itself) is
-- found at run time and scanned once. Each table runs in its own exception
-- block, so one failing table (lock timeout, statement timeout) is listed in
-- scan_errors instead of failing the call. Live baseline 2026-10-13: 258 tables
-- in 0.32 s, against the 8 s statement_timeout of PostgREST's authenticator.
--
-- is_default / is_platform are read through to_jsonb(), so this function keeps
-- working if M1 is rolled back (the counts are then 0). Independent of M1/M2.
-- Rollback: docs/validation/VTID-05149/rollback-m3.sql.

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.ci_tenant_isolation_health()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  r record;
  v_foreign bigint;
  v_null bigint;
  v_tables int := 0;
  v_foreign_total bigint := 0;
  v_null_total bigint := 0;
  v_foreign_list jsonb := '[]'::jsonb;
  v_null_list jsonb := '[]'::jsonb;
  v_errors jsonb := '[]'::jsonb;
  v_text_tables int;
  v_zero_primary bigint;
  v_multi_primary bigint;
  v_auth_without bigint;
  v_m_not_ut bigint;
  v_ut_not_m bigint;
  v_default int;
  v_platform int;
BEGIN
  FOR r IN
    SELECT c.table_name::text AS table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.data_type = 'uuid'
       AND c.table_name <> 'tenants'
     ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format(
        'select count(*) filter (where tenant_id is not null and tenant_id not in (select tenant_id from public.tenants)), '
        'count(*) filter (where tenant_id is null) from public.%I', r.table_name)
        INTO v_foreign, v_null;
      v_tables := v_tables + 1;
      v_foreign_total := v_foreign_total + v_foreign;
      v_null_total := v_null_total + v_null;
      IF v_foreign > 0 THEN
        v_foreign_list := v_foreign_list || jsonb_build_object('table', r.table_name, 'rows', v_foreign);
      END IF;
      IF v_null > 0 THEN
        v_null_list := v_null_list || jsonb_build_object('table', r.table_name, 'rows', v_null);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object('table', r.table_name, 'sqlstate', SQLSTATE);
    END;
  END LOOP;

  SELECT count(DISTINCT c.table_name) INTO v_text_tables
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
   WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.data_type IN ('text', 'character varying');

  SELECT count(*) FILTER (WHERE primaries = 0), count(*) FILTER (WHERE primaries > 1)
    INTO v_zero_primary, v_multi_primary
    FROM (SELECT user_id, count(*) FILTER (WHERE is_primary) AS primaries
            FROM public.user_tenants GROUP BY user_id) s;

  SELECT count(*) INTO v_auth_without
    FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = u.id);

  SELECT count(*) INTO v_m_not_ut
    FROM public.memberships m
   WHERE NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = m.user_id AND ut.tenant_id = m.tenant_id);

  SELECT count(*) INTO v_ut_not_m
    FROM public.user_tenants ut
   WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = ut.user_id AND m.tenant_id = ut.tenant_id);

  SELECT count(*) FILTER (WHERE coalesce((to_jsonb(t) ->> 'is_default')::boolean, false)),
         count(*) FILTER (WHERE coalesce((to_jsonb(t) ->> 'is_platform')::boolean, false))
    INTO v_default, v_platform
    FROM public.tenants t;

  RETURN json_build_object(
    'generated_at', now(),
    'tables_scanned', v_tables,
    'text_tenant_id_tables', v_text_tables,
    'foreign_tenant_rows', v_foreign_total,
    'foreign_tenant_tables', (SELECT coalesce(jsonb_agg(e ORDER BY (e ->> 'rows')::bigint DESC, e ->> 'table'), '[]'::jsonb)
                                FROM (SELECT e FROM jsonb_array_elements(v_foreign_list) e
                                       ORDER BY (e ->> 'rows')::bigint DESC, e ->> 'table' LIMIT 25) s),
    'null_tenant_rows', v_null_total,
    'null_tenant_tables', (SELECT coalesce(jsonb_agg(e ORDER BY (e ->> 'rows')::bigint DESC, e ->> 'table'), '[]'::jsonb)
                             FROM (SELECT e FROM jsonb_array_elements(v_null_list) e
                                    ORDER BY (e ->> 'rows')::bigint DESC, e ->> 'table' LIMIT 25) s),
    'users_zero_primary', v_zero_primary,
    'users_multi_primary', v_multi_primary,
    'auth_users_without_membership', v_auth_without,
    'memberships_not_in_user_tenants', v_m_not_ut,
    'user_tenants_not_in_memberships', v_ut_not_m,
    'default_tenant_count', v_default,
    'platform_tenant_count', v_platform,
    'scan_errors', v_errors
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.ci_tenant_isolation_health() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ci_tenant_isolation_health() TO service_role;

DO $check$
BEGIN
  IF has_function_privilege('anon', 'public.ci_tenant_isolation_health()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ci_tenant_isolation_health()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05149 M3: ci_tenant_isolation_health() must not be executable by members (anon/authenticated)';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.ci_tenant_isolation_health()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05149 M3: service_role must be able to execute ci_tenant_isolation_health()';
  END IF;
END $check$;

COMMIT;
