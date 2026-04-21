-- DIAG: has the scanner produced any admin_insights yet?
do $$
declare
  r record;
  n_total int;
  n_open int;
begin
  select count(*) into n_total from public.admin_insights;
  select count(*) into n_open from public.admin_insights where status in ('open','pending_approval');
  raise notice 'admin_insights total rows: % open: %', n_total, n_open;
  raise notice '';

  raise notice '=== open insights (last 20) ===';
  for r in
    select tenant_id, scanner, severity, title, natural_key, status, created_at
    from public.admin_insights
    order by created_at desc
    limit 20
  loop
    raise notice 'tenant=% scanner=% sev=% status=% key=%',
      substring(r.tenant_id::text, 1, 8), r.scanner, r.severity, r.status, r.natural_key;
    raise notice '  title: %', r.title;
  end loop;
end$$;
