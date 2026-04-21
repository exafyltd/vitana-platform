-- DIAG: role state for dstevanovic@hotmail.com (the community-app test user)
do $$
declare
  uid uuid := '0adc6ff6-ff1e-44f0-9849-fc18af76e86c';
  r record;
begin
  -- Look up real user_id by email (in case the above UUID is wrong)
  select id into uid from auth.users where email ilike 'dstevanovic@hotmail%' limit 1;
  raise notice 'hotmail user_id: %', uid;
  raise notice '';

  raise notice '=== user_tenants ===';
  for r in
    select tenant_id, active_role, is_primary from public.user_tenants where user_id = uid
  loop
    raise notice '  tenant=% active_role=% primary=%',
      substring(r.tenant_id::text, 1, 8), r.active_role, r.is_primary;
  end loop;

  raise notice '';
  raise notice '=== role_preferences (newest first) ===';
  for r in
    select tenant_id, role, updated_at from public.role_preferences where user_id = uid order by updated_at desc
  loop
    raise notice '  tenant=% role=% updated=%',
      substring(r.tenant_id::text, 1, 8), r.role, r.updated_at;
  end loop;

  raise notice '';
  raise notice '=== last 20 session.start active_role values for hotmail user (last 6h) ===';
  for r in
    select
      to_char(created_at, 'HH24:MI:SS') as t,
      metadata ->> 'active_role' as role,
      metadata ->> 'session_id' as sid
    from public.oasis_events
    where topic = 'vtid.live.session.start'
      and (metadata ->> 'user_id') = uid::text
      and created_at > now() - interval '6 hours'
    order by created_at desc
    limit 20
  loop
    raise notice '  % role=% sid=%',
      r.t, coalesce(r.role, '(null)'), substring(coalesce(r.sid, '-'), 1, 20);
  end loop;
end$$;
