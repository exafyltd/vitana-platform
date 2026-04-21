-- DIAG: inspect role_preference table + RPC signatures to see why the
-- gateway isn't reading the user's admin selection.

do $$
declare
  r record;
  row_count int;
begin
  raise notice '=== role_preference schema ===';
  for r in
    select column_name, data_type
    from information_schema.columns
    where table_schema = 'public' and table_name = 'role_preference'
    order by ordinal_position
  loop
    raise notice '  % (%)', r.column_name, r.data_type;
  end loop;

  select count(*) into row_count from public.role_preference;
  raise notice 'role_preference total rows: %', row_count;

  raise notice '';
  raise notice '=== sample rows (first 10) ===';
  for r in
    select * from public.role_preference limit 10
  loop
    raise notice '  %', r::text;
  end loop;

  raise notice '';
  raise notice '=== get_role_preference / set_role_preference signatures ===';
  for r in
    select p.proname, pg_get_function_arguments(p.oid) as args,
           pg_get_function_result(p.oid) as result
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('get_role_preference', 'set_role_preference', 'me_set_active_role')
    order by p.proname
  loop
    raise notice '  %(%) returns %', r.proname, r.args, r.result;
  end loop;
end$$;
