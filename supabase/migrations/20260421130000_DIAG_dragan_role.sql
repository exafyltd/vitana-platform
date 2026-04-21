-- DIAG: find the Exafy admin (Dragan) user's role state across all tables
-- so we can see if the gateway query would find the admin preference.

do $$
declare
  dragan_user_id uuid;
  r record;
begin
  -- Find the user by email
  select id into dragan_user_id
  from auth.users
  where email ilike 'd.stevanovic%'
  limit 1;

  if dragan_user_id is null then
    raise notice 'No user found with email starting d.stevanovic@';
    return;
  end if;

  raise notice 'Found user_id: %', dragan_user_id;
  raise notice '';

  raise notice '=== user_tenants rows ===';
  for r in
    select tenant_id, active_role, is_primary
    from public.user_tenants
    where user_id = dragan_user_id
    order by is_primary desc
  loop
    raise notice '  tenant=% active_role=% primary=%',
      r.tenant_id, r.active_role, r.is_primary;
  end loop;

  raise notice '';
  raise notice '=== role_preferences rows ===';
  for r in
    select tenant_id, role, updated_at
    from public.role_preferences
    where user_id = dragan_user_id
    order by updated_at desc
  loop
    raise notice '  tenant=% role=% updated=%',
      r.tenant_id, r.role, r.updated_at;
  end loop;

  raise notice '';
  raise notice '=== tenants the user belongs to ===';
  for r in
    select t.tenant_id, t.slug, t.name
    from public.tenants t
    join public.user_tenants ut on ut.tenant_id = t.tenant_id
    where ut.user_id = dragan_user_id
  loop
    raise notice '  tenant=% slug=% name=%', r.tenant_id, r.slug, r.name;
  end loop;
end$$;
