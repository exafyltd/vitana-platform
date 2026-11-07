-- VTID-05506 (mt-m3-r2/provision-erp-monitoring-db, E2): public.ci_tenant_isolation_health_by_tenant().
--
-- The same counts as ci_tenant_isolation_health() (VTID-05149, 20261014000300, untouched), one row per tenant, so the
-- morning health check and the admin health read can say WHICH tenant has drift. For every column the rows sum to the
-- single-number function:
--   * every registered tenant is listed, zeros included;
--   * a tenant id that is on a row but not in `tenants` (dangling) gets its own row: is_registered = false, slug null;
--   * counts that belong to no tenant (rows with a null tenant_id, users with zero / several primary tenants, auth users
--     without a membership) sit in one row whose tenant_id is null.
-- Counts and tenant ids only, never row content. Every public base table with a uuid tenant_id (except tenants) is
-- scanned once, each in its own exception block like 20261014000300: a failing table is listed in scan_errors instead
-- of failing the call. is_default / is_platform are read through to_jsonb(), as in the single-number function.
-- STABLE SECURITY DEFINER, service_role only. Creates no table and no policy. Expand-only, idempotent.
-- Rollback: docs/validation/VTID-05506/rollback-141100-isolation-health-by-tenant.sql (drops the function).

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.ci_tenant_isolation_health_by_tenant()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $fn$
DECLARE
  r record;
  c record;
  v_tbl jsonb;
  v_foreign jsonb := '{}'::jsonb;   -- tenant id (text) -> rows whose tenant id is not in tenants
  v_null_total bigint := 0;         -- rows with a null tenant id (all tables)
  v_m jsonb;                        -- tenant id ('' = null) -> memberships without a user_tenants row
  v_ut jsonb;                       -- tenant id ('' = null) -> user_tenants without a membership
  v_errors jsonb := '[]'::jsonb;
  v_zero_primary bigint;
  v_multi_primary bigint;
  v_auth_without bigint;
  v_rows jsonb;
  v_totals jsonb;
BEGIN
  FOR r IN
    SELECT c2.table_name::text AS table_name
      FROM information_schema.columns c2
      JOIN information_schema.tables t
        ON t.table_schema = c2.table_schema AND t.table_name = c2.table_name AND t.table_type = 'BASE TABLE'
     WHERE c2.table_schema = 'public' AND c2.column_name = 'tenant_id' AND c2.data_type = 'uuid'
       AND c2.table_name <> 'tenants'
     ORDER BY c2.table_name
  LOOP
    BEGIN
      -- One aggregate per table, merged only after it succeeded, so a failing table adds nothing.
      EXECUTE format(
        'select coalesce(jsonb_object_agg(coalesce(tenant_id::text, ''''), n), ''{}''::jsonb) '
        'from (select tenant_id, count(*) as n from public.%I '
        'where tenant_id is null or tenant_id not in (select tenant_id from public.tenants) group by tenant_id) s', r.table_name)
        INTO v_tbl;
      FOR c IN SELECT key, value FROM jsonb_each_text(v_tbl) LOOP
        IF c.key = '' THEN
          v_null_total := v_null_total + c.value::bigint;
        ELSE
          v_foreign := jsonb_set(v_foreign, ARRAY[c.key], to_jsonb(coalesce((v_foreign ->> c.key)::bigint, 0) + c.value::bigint));
        END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors || jsonb_build_object('table', r.table_name, 'sqlstate', SQLSTATE);
    END;
  END LOOP;

  SELECT count(*) FILTER (WHERE primaries = 0), count(*) FILTER (WHERE primaries > 1)
    INTO v_zero_primary, v_multi_primary
    FROM (SELECT user_id, count(*) FILTER (WHERE is_primary) AS primaries
            FROM public.user_tenants GROUP BY user_id) s;

  SELECT count(*) INTO v_auth_without
    FROM auth.users u
   WHERE NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = u.id);

  SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) INTO v_m
    FROM (SELECT coalesce(m.tenant_id::text, '') AS k, count(*) AS n
            FROM public.memberships m
           WHERE NOT EXISTS (SELECT 1 FROM public.user_tenants ut WHERE ut.user_id = m.user_id AND ut.tenant_id = m.tenant_id)
           GROUP BY 1) s;

  SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) INTO v_ut
    FROM (SELECT coalesce(ut.tenant_id::text, '') AS k, count(*) AS n
            FROM public.user_tenants ut
           WHERE NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.user_id = ut.user_id AND m.tenant_id = ut.tenant_id)
           GROUP BY 1) s;

  -- One row per registered tenant, per dangling tenant id, and the one tenant-less row ('').
  SELECT coalesce(jsonb_agg(row_json ORDER BY is_reg DESC, slug, tid), '[]'::jsonb) INTO v_rows
    FROM (
      SELECT i.tid, (t.tenant_id IS NOT NULL) AS is_reg, t.slug,
             jsonb_build_object(
               'tenant_id', to_jsonb(nullif(i.tid, '')::uuid),
               'slug', to_jsonb(t.slug),
               'is_registered', (t.tenant_id IS NOT NULL),
               'foreign_tenant_rows', CASE WHEN i.tid = '' THEN 0 ELSE coalesce((v_foreign ->> i.tid)::bigint, 0) END,
               'null_tenant_rows', CASE WHEN i.tid = '' THEN v_null_total ELSE 0 END,
               'users_zero_primary', CASE WHEN i.tid = '' THEN v_zero_primary ELSE 0 END,
               'users_multi_primary', CASE WHEN i.tid = '' THEN v_multi_primary ELSE 0 END,
               'auth_users_without_membership', CASE WHEN i.tid = '' THEN v_auth_without ELSE 0 END,
               'memberships_not_in_user_tenants', coalesce((v_m ->> i.tid)::bigint, 0),
               'user_tenants_not_in_memberships', coalesce((v_ut ->> i.tid)::bigint, 0),
               'default_tenant_count', CASE WHEN coalesce((to_jsonb(t) ->> 'is_default')::boolean, false) THEN 1 ELSE 0 END,
               'platform_tenant_count', CASE WHEN coalesce((to_jsonb(t) ->> 'is_platform')::boolean, false) THEN 1 ELSE 0 END
             ) AS row_json
        FROM (
          SELECT tn.tenant_id::text AS tid FROM public.tenants tn
          UNION SELECT jsonb_object_keys(v_foreign)
          UNION SELECT jsonb_object_keys(v_m)
          UNION SELECT jsonb_object_keys(v_ut)
          UNION SELECT ''
        ) i
        LEFT JOIN public.tenants t ON t.tenant_id::text = i.tid
    ) q;

  SELECT jsonb_build_object(
           'foreign_tenant_rows', coalesce(sum((e ->> 'foreign_tenant_rows')::bigint), 0)::bigint,
           'null_tenant_rows', coalesce(sum((e ->> 'null_tenant_rows')::bigint), 0)::bigint,
           'users_zero_primary', coalesce(sum((e ->> 'users_zero_primary')::bigint), 0)::bigint,
           'users_multi_primary', coalesce(sum((e ->> 'users_multi_primary')::bigint), 0)::bigint,
           'auth_users_without_membership', coalesce(sum((e ->> 'auth_users_without_membership')::bigint), 0)::bigint,
           'memberships_not_in_user_tenants', coalesce(sum((e ->> 'memberships_not_in_user_tenants')::bigint), 0)::bigint,
           'user_tenants_not_in_memberships', coalesce(sum((e ->> 'user_tenants_not_in_memberships')::bigint), 0)::bigint,
           'default_tenant_count', coalesce(sum((e ->> 'default_tenant_count')::bigint), 0)::bigint,
           'platform_tenant_count', coalesce(sum((e ->> 'platform_tenant_count')::bigint), 0)::bigint)
    INTO v_totals
    FROM jsonb_array_elements(v_rows) e;

  RETURN json_build_object(
    'generated_at', now(),
    'tenants', v_rows,
    'totals', v_totals,
    'scan_errors', v_errors
  );
END;
$fn$;

COMMENT ON FUNCTION public.ci_tenant_isolation_health_by_tenant() IS
  'VTID-05506: the counts of ci_tenant_isolation_health() per tenant (registered tenants, dangling tenant ids, one tenant-less row); the rows sum to the single-number function. Counts and ids only. service_role only.';

REVOKE ALL ON FUNCTION public.ci_tenant_isolation_health_by_tenant() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ci_tenant_isolation_health_by_tenant() TO service_role;

DO $check$
BEGIN
  IF has_function_privilege('anon', 'public.ci_tenant_isolation_health_by_tenant()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.ci_tenant_isolation_health_by_tenant()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05506: ci_tenant_isolation_health_by_tenant() must not be executable by members (anon/authenticated)';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.ci_tenant_isolation_health_by_tenant()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VTID-05506: service_role must be able to execute ci_tenant_isolation_health_by_tenant()';
  END IF;
END $check$;

COMMIT;
