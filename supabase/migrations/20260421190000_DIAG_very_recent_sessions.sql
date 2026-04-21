-- DIAG: very recent sessions (last 30 min) for hotmail user + any null-role sessions
do $$
declare
  r record;
  uid uuid := '0adc6ff6-acb0-4dca-99d0-295211a40e3e';
begin
  raise notice '=== hotmail user sessions last 30 min ===';
  for r in
    select
      to_char(created_at, 'HH24:MI:SS') as t,
      metadata ->> 'session_id' as sid,
      metadata ->> 'active_role' as role,
      metadata ->> 'transport' as transport,
      metadata ->> 'tenant_id' as tenant
    from public.oasis_events
    where topic = 'vtid.live.session.start'
      and (metadata ->> 'user_id') = uid::text
      and created_at > now() - interval '30 minutes'
    order by created_at desc
    limit 10
  loop
    raise notice '  % sid=% role=% transport=% tenant=%',
      r.t, substring(r.sid, 1, 20),
      coalesce(r.role, '(null)'),
      coalesce(r.transport, '-'),
      substring(coalesce(r.tenant, '-'), 1, 8);
  end loop;

  raise notice '';
  raise notice '=== last 5 session.start with NULL active_role (any user, last 1h) ===';
  for r in
    select
      to_char(created_at, 'HH24:MI:SS') as t,
      metadata ->> 'session_id' as sid,
      metadata ->> 'email' as email,
      metadata ->> 'transport' as transport
    from public.oasis_events
    where topic = 'vtid.live.session.start'
      and (metadata ->> 'active_role') is null
      and created_at > now() - interval '1 hour'
    order by created_at desc
    limit 5
  loop
    raise notice '  % sid=% email=% transport=%',
      r.t, substring(r.sid, 1, 20),
      coalesce(r.email, '-'), coalesce(r.transport, '-');
  end loop;
end$$;
