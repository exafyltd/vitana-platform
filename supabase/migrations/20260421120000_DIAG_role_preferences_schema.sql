-- DIAG: columns + sample rows of public.role_preferences so we can query
-- it directly from the gateway using service role.

do $$
declare
  r record;
begin
  raise notice '=== role_preferences columns ===';
  for r in
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'role_preferences'
    order by ordinal_position
  loop
    raise notice '  % (%) nullable=%', r.column_name, r.data_type, r.is_nullable;
  end loop;

  raise notice '';
  raise notice '=== sample rows (up to 10) ===';
  for r in
    select * from public.role_preferences limit 10
  loop
    raise notice '  %', r::text;
  end loop;

  raise notice '';
  raise notice '=== row count ===';
  raise notice 'total: %', (select count(*) from public.role_preferences);
end$$;
