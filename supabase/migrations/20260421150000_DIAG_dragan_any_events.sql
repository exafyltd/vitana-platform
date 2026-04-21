-- DIAG: any recent OASIS events mentioning Dragan's user_id
do $$
declare
  r record;
  dragan_user_id uuid := 'c5a4daf9-190a-4a9e-9638-d6b32f85244a';
  n_total int;
begin
  -- Total events with this user_id (any topic)
  select count(*) into n_total
  from public.oasis_events
  where (metadata ->> 'user_id') = dragan_user_id::text
    and created_at > now() - interval '6 hours';
  raise notice 'Events in last 6h with user_id=% : %', dragan_user_id, n_total;

  raise notice '';
  raise notice '=== last 20 Dragan events (6h) ===';
  for r in
    select
      to_char(created_at, 'HH24:MI:SS') as t,
      topic,
      (metadata ->> 'active_role') as role,
      (metadata ->> 'session_id') as sid
    from public.oasis_events
    where (metadata ->> 'user_id') = dragan_user_id::text
      and created_at > now() - interval '6 hours'
    order by created_at desc
    limit 20
  loop
    raise notice '  % topic=% role=% sid=%',
      r.t, r.topic,
      coalesce(r.role, '-'),
      coalesce(substring(r.sid, 1, 20), '-');
  end loop;

  raise notice '';
  raise notice '=== count by topic (6h) ===';
  for r in
    select topic, count(*) as n
    from public.oasis_events
    where (metadata ->> 'user_id') = dragan_user_id::text
      and created_at > now() - interval '6 hours'
    group by topic
    order by 2 desc
  loop
    raise notice '  % — %', lpad(r.n::text, 4), r.topic;
  end loop;
end$$;
