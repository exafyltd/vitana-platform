-- DIAG: full 2-hour session traces — ordered list of every diag stage per
-- session so we can see EXACTLY where each conversation broke.
--
-- Reads orb.live.diag + orb.live.stall_detected + vtid.live.session.{start,stop}
-- + orb.live.tool_loop_guard_activated + orb.live.tool.executed.

do $$
declare
  sid text;
  r record;
  session_count int;
begin
  raise notice '=== ORB SESSION TRACES — LAST 2 HOURS ===';

  -- Count sessions first
  select count(distinct metadata ->> 'session_id') into session_count
  from public.oasis_events
  where topic = 'vtid.live.session.start' and created_at > now() - interval '2 hours';
  raise notice 'Distinct sessions: %', session_count;
  raise notice '';

  -- For each session, dump ordered events
  for sid in
    select distinct metadata ->> 'session_id' as sid
    from public.oasis_events
    where topic = 'vtid.live.session.start' and created_at > now() - interval '2 hours'
    order by 1
  loop
    raise notice '---------- session: % ----------', sid;
    for r in
      select
        to_char(created_at, 'HH24:MI:SS') as t,
        topic,
        (metadata ->> 'stage') as stage,
        (metadata ->> 'reason') as reason,
        (metadata ->> 'code') as code,
        (metadata ->> 'tools') as tools,
        (metadata ->> 'tool_name') as tool_name,
        (metadata ->> 'consecutive') as consecutive,
        (metadata ->> 'ws_state') as ws_state
      from public.oasis_events
      where (metadata ->> 'session_id') = sid
        and created_at > now() - interval '3 hours'
      order by created_at asc
    loop
      raise notice '  % % | stage=% reason=% code=% tool=% cons=% ws=%',
        r.t, r.topic,
        coalesce(r.stage, '-'),
        coalesce(r.reason, '-'),
        coalesce(r.code, '-'),
        coalesce(r.tool_name, r.tools, '-'),
        coalesce(r.consecutive, '-'),
        coalesce(r.ws_state, '-');
    end loop;
    raise notice '';
  end loop;

  raise notice '=== END TRACES ===';
end$$;
