-- DIAG: last 10 sessions for hotmail user with FULL metadata — especially
-- active_role, active_role_source, and any route info
do $$
declare
  r record;
  uid uuid := '0adc6ff6-acb0-4dca-99d0-295211a40e3e';
begin
  raise notice '=== last 10 hotmail sessions (detailed) ===';
  for r in
    select
      to_char(created_at, 'HH24:MI:SS') as t,
      metadata ->> 'session_id' as sid,
      metadata ->> 'active_role' as role,
      metadata ->> 'transport' as transport,
      metadata ->> 'origin' as origin,
      metadata ->> 'user_agent' as ua
    from public.oasis_events
    where topic = 'vtid.live.session.start'
      and (metadata ->> 'user_id') = uid::text
    order by created_at desc
    limit 10
  loop
    raise notice '% sid=% role=% origin=%',
      r.t,
      substring(coalesce(r.sid, '-'), 1, 24),
      coalesce(r.role, '(null)'),
      substring(coalesce(r.origin, '-'), 1, 40);
  end loop;

  raise notice '';
  raise notice '=== current role_preferences for hotmail ===';
  for r in
    select tenant_id, role, to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') as updated
    from public.role_preferences
    where user_id = uid
    order by updated_at desc
  loop
    raise notice '  tenant=% role=% updated=%',
      substring(r.tenant_id::text, 1, 8), r.role, r.updated;
  end loop;

  raise notice '';
  raise notice '=== user_tenants for hotmail ===';
  for r in
    select tenant_id, active_role, is_primary
    from public.user_tenants
    where user_id = uid
  loop
    raise notice '  tenant=% active_role=% primary=%',
      substring(r.tenant_id::text, 1, 8), r.active_role, r.is_primary;
  end loop;
end$$;
