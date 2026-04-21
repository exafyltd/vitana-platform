-- DIAG: has the admin-awareness-worker populated KPI snapshots yet?
do $$
declare
  r record;
  n_current int;
  n_daily int;
begin
  select count(*) into n_current from public.tenant_kpi_current;
  select count(*) into n_daily from public.tenant_kpi_daily;
  raise notice 'tenant_kpi_current rows: %', n_current;
  raise notice 'tenant_kpi_daily rows: %', n_daily;
  raise notice '';

  raise notice '=== current snapshots (tenant × kpi) ===';
  for r in
    select tenant_id, generated_at, computation_duration_ms, source_version,
           kpi -> 'users' as users,
           kpi -> 'community' as community,
           kpi -> 'autopilot' as autopilot
    from public.tenant_kpi_current
    order by generated_at desc
    limit 5
  loop
    raise notice 'tenant=% generated=% duration=%ms ver=%',
      substring(r.tenant_id::text, 1, 8),
      to_char(r.generated_at, 'HH24:MI:SS'),
      r.computation_duration_ms, r.source_version;
    raise notice '  users=%', r.users::text;
    raise notice '  community=%', r.community::text;
    raise notice '  autopilot=%', r.autopilot::text;
  end loop;
end$$;
