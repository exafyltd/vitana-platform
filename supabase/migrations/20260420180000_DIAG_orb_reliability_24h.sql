-- DIAG: Pull the last 24 h of orb reliability signals so we can see what's
-- actually breaking in production. Read-only; prints to workflow logs via
-- NOTICE.
--
-- What we're looking for:
--   1. How many sessions started / stopped in 24 h
--   2. How often watchdog fires, and with what reason
--   3. How often transparent reconnect triggers, and does it succeed
--   4. Distribution of upstream_ws_close codes
--   5. How often stall_detected fires
--   6. Tool-loop-guard hit rate (should be ~0 after PR #743)
--   7. Top diag stages in the last 24 h

do $$
declare
  r record;
  s_started int;
  s_stopped int;
  w_fired int;
  ws_close int;
  stall_det int;
  loop_guard int;
  reconnect_trig int;
  connection_failed int;
begin
  raise notice '';
  raise notice '==========================================================';
  raise notice '=== ORB RELIABILITY DIAGNOSTIC — LAST 24 HOURS ==========';
  raise notice '==========================================================';

  select count(*) into s_started from public.oasis_events
    where topic = 'vtid.live.session.start' and created_at > now() - interval '24 hours';
  select count(*) into s_stopped from public.oasis_events
    where topic = 'vtid.live.session.stop' and created_at > now() - interval '24 hours';
  raise notice 'Sessions started: %  stopped: %  (gap indicates crashed sessions)',
    s_started, s_stopped;

  select count(*) into w_fired from public.oasis_events
    where topic = 'orb.live.diag' and (metadata ->> 'stage') = 'watchdog_fired'
      and created_at > now() - interval '24 hours';
  raise notice 'watchdog_fired events: %', w_fired;

  select count(*) into ws_close from public.oasis_events
    where topic = 'orb.live.diag' and (metadata ->> 'stage') = 'upstream_ws_close'
      and created_at > now() - interval '24 hours';
  raise notice 'upstream_ws_close events: %', ws_close;

  select count(*) into stall_det from public.oasis_events
    where topic = 'orb.live.stall_detected'
      and created_at > now() - interval '24 hours';
  raise notice 'orb.live.stall_detected events: %', stall_det;

  select count(*) into loop_guard from public.oasis_events
    where topic = 'orb.live.tool_loop_guard_activated'
      and created_at > now() - interval '24 hours';
  raise notice 'orb.live.tool_loop_guard_activated events: %', loop_guard;

  select count(*) into reconnect_trig from public.oasis_events
    where topic = 'orb.live.diag' and (metadata ->> 'stage') = 'reconnect_triggered'
      and created_at > now() - interval '24 hours';
  raise notice 'reconnect_triggered events: %', reconnect_trig;

  select count(*) into connection_failed from public.oasis_events
    where topic = 'orb.live.connection_failed'
      and created_at > now() - interval '24 hours';
  raise notice 'orb.live.connection_failed events: %', connection_failed;

  raise notice '';
  raise notice '--- Top 15 diag stages by volume (last 24h) ---';
  for r in
    select (metadata ->> 'stage') as stage, count(*) as n
    from public.oasis_events
    where topic = 'orb.live.diag' and created_at > now() - interval '24 hours'
    group by 1 order by 2 desc limit 15
  loop
    raise notice '  % — %', lpad(r.n::text, 6, ' '), r.stage;
  end loop;

  raise notice '';
  raise notice '--- watchdog_fired reasons (last 24h) ---';
  for r in
    select (metadata ->> 'reason') as reason, count(*) as n
    from public.oasis_events
    where topic = 'orb.live.diag' and (metadata ->> 'stage') = 'watchdog_fired'
      and created_at > now() - interval '24 hours'
    group by 1 order by 2 desc
  loop
    raise notice '  % — reason=%', lpad(r.n::text, 6, ' '), coalesce(r.reason, '(null)');
  end loop;

  raise notice '';
  raise notice '--- upstream_ws_close codes (last 24h) ---';
  for r in
    select (metadata ->> 'code') as code, count(*) as n
    from public.oasis_events
    where topic = 'orb.live.diag' and (metadata ->> 'stage') = 'upstream_ws_close'
      and created_at > now() - interval '24 hours'
    group by 1 order by 2 desc
  loop
    raise notice '  % — code=%', lpad(r.n::text, 6, ' '), coalesce(r.code, '(null)');
  end loop;

  raise notice '';
  raise notice '--- orb.live.stall_detected reasons (last 24h) ---';
  for r in
    select (metadata ->> 'reason') as reason, count(*) as n
    from public.oasis_events
    where topic = 'orb.live.stall_detected'
      and created_at > now() - interval '24 hours'
    group by 1 order by 2 desc
  loop
    raise notice '  % — reason=%', lpad(r.n::text, 6, ' '), coalesce(r.reason, '(null)');
  end loop;

  raise notice '';
  raise notice '--- Session transport distribution (last 24h) ---';
  for r in
    select coalesce(metadata ->> 'transport', '(null)') as transport, count(*) as n
    from public.oasis_events
    where topic = 'vtid.live.session.start' and created_at > now() - interval '24 hours'
    group by 1 order by 2 desc
  loop
    raise notice '  % — transport=%', lpad(r.n::text, 6, ' '), r.transport;
  end loop;

  raise notice '';
  raise notice '--- pre_greeting_ms quartiles (last 24h) ---';
  for r in
    select
      percentile_cont(0.5) within group (order by (metadata ->> 'pre_greeting_ms')::int) as p50,
      percentile_cont(0.75) within group (order by (metadata ->> 'pre_greeting_ms')::int) as p75,
      percentile_cont(0.95) within group (order by (metadata ->> 'pre_greeting_ms')::int) as p95,
      count(*) as n
    from public.oasis_events
    where topic = 'orb.live.greeting.delivered' and created_at > now() - interval '24 hours'
      and (metadata ->> 'pre_greeting_ms') ~ '^[0-9]+$'
  loop
    raise notice '  p50=%ms p75=%ms p95=%ms n=%', r.p50, r.p75, r.p95, r.n;
  end loop;

  raise notice '';
  raise notice '=== END DIAGNOSTIC ======================================';
end$$;
