-- DIAG: Surface actual column names on public.tenants and public.user_tenants
-- so we can fix the Phase 1 migration which assumed tenants.id and
-- user_tenants.is_active.

do $$
declare
  col record;
begin
  raise notice '=== public.tenants columns ===';
  for col in
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'tenants'
    order by ordinal_position
  loop
    raise notice '  % (%) nullable=%', col.column_name, col.data_type, col.is_nullable;
  end loop;

  raise notice '=== public.user_tenants columns ===';
  for col in
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public' and table_name = 'user_tenants'
    order by ordinal_position
  loop
    raise notice '  % (%) nullable=%', col.column_name, col.data_type, col.is_nullable;
  end loop;
end$$;
