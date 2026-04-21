-- DIAG: find every table with 'role' in the name and every RPC function
-- that reads/writes roles.

do $$
declare
  r record;
begin
  raise notice '=== tables with role in name ===';
  for r in
    select table_schema, table_name
    from information_schema.tables
    where table_schema in ('public','auth')
      and (table_name ilike '%role%' or table_name ilike '%preference%')
    order by 1, 2
  loop
    raise notice '  %.%', r.table_schema, r.table_name;
  end loop;

  raise notice '';
  raise notice '=== all role-related RPC functions (public) ===';
  for r in
    select p.proname, pg_get_function_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (p.proname ilike '%role%' or p.proname ilike '%preference%')
    order by p.proname
  loop
    raise notice '  %(%)', r.proname, r.args;
  end loop;

  raise notice '';
  raise notice '=== tenant_user / user_tenants snapshot (10 rows) ===';
  for r in
    select user_id, tenant_id, active_role, is_primary from public.user_tenants limit 10
  loop
    raise notice '  user=% tenant=% active_role=% primary=%',
      substring(r.user_id::text,1,8),
      substring(r.tenant_id::text,1,8),
      r.active_role, r.is_primary;
  end loop;
end$$;
