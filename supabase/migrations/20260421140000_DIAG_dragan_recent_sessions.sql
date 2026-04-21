-- DIAG: what active_role did the last 5 sessions for Dragan actually emit?
-- Tells us what the gateway ACTUALLY resolved for this user.

do $$
declare
  r record;
  dragan_user_id uuid;
begin
  select id into dragan_user_id from auth.users where email ilike 'd.stevanovic%' limit 1;
  raise notice 'Dragan user_id: %', dragan_user_id;
  raise notice '';

  raise notice '=== last 5 vtid.live.session.start events for Dragan ===';
  for r in
    select
      to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') as t,
      metadata ->> 'session_id' as sid,
      metadata ->> 'tenant_id' as tenant,
      metadata ->> 'active_role' as active_role,
      metadata ->> 'transport' as transport,
      metadata ->> 'user_agent' as ua
    from public.oasis_events
    where topic = 'vtid.live.session.start'
      and (metadata ->> 'user_id') = dragan_user_id::text
    order by created_at desc
    limit 5
  loop
    raise notice 'time=% sid=%', r.t, substring(r.sid, 1, 20);
    raise notice '  tenant=% active_role=% transport=%',
      substring(coalesce(r.tenant, 'null'), 1, 8),
      coalesce(r.active_role, '(null)'),
      coalesce(r.transport, '-');
    raise notice '  UA=%', substring(coalesce(r.ua, '-'), 1, 60);
  end loop;
end$$;
