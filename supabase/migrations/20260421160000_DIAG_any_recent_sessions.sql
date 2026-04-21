-- DIAG: most recent orb sessions across all users, to see which user_id is
-- actually hitting the gateway right now.
do $$
declare
  r record;
begin
  raise notice '=== last 10 vtid.live.session.start events (any user) ===';
  for r in
    select
      to_char(created_at, 'HH24:MI:SS') as t,
      metadata ->> 'user_id' as uid,
      metadata ->> 'email' as email,
      metadata ->> 'tenant_id' as tenant,
      metadata ->> 'active_role' as role,
      metadata ->> 'session_id' as sid
    from public.oasis_events
    where topic = 'vtid.live.session.start'
      and created_at > now() - interval '2 hours'
    order by created_at desc
    limit 10
  loop
    raise notice '% sid=% user=% email=% tenant=% role=%',
      r.t,
      substring(coalesce(r.sid, '-'), 1, 18),
      substring(coalesce(r.uid, '-'), 1, 8),
      coalesce(r.email, '-'),
      substring(coalesce(r.tenant, '-'), 1, 8),
      coalesce(r.role, '(null)');
  end loop;
end$$;
