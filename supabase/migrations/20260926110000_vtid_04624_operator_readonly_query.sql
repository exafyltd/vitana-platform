-- VTID-04624: read-only SQL for the Operator Console against the LIVE database.
--
-- dev_run_sql_readonly (VTID-04023) was designed for a read-only login role on
-- the Aurora reader. That credential was never provisioned, and Aurora has had
-- no replication since the 2026-09-21 full load (the CDC task is `failed`), so
-- it would answer from a stale copy anyway. Owner decision 2026-09-26: the tool
-- reads the live Supabase database, read-only, through this function.
--
-- Guards, independent of each other and of the gateway's own statement
-- validator (single SELECT / WITH / EXPLAIN, no ';', no set_config, no
-- pg_sleep, no nextval, no locking clause, no SELECT INTO, no COPY):
--   * EXECUTE is granted to service_role only — not anon, not authenticated.
--   * transaction_read_only is switched on before the statement runs, so any
--     write inside it fails ("cannot execute … in a read-only transaction"),
--     and it cannot be switched back within the transaction.
--   * lock_timeout 2 s; the PostgREST login role (authenticator) caps every
--     request at statement_timeout 8 s.
--   * The statement runs as the subquery of a jsonb aggregate, so it must be a
--     single row-returning query.
--   * SECURITY INVOKER: it never runs with more privilege than the caller.

create or replace function public.operator_readonly_query(q text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  result jsonb;
begin
  if q is null or length(btrim(q)) = 0 then
    raise exception 'operator_readonly_query: empty statement';
  end if;
  perform set_config('transaction_read_only', 'on', true);
  perform set_config('lock_timeout', '2000', true);
  execute format('select coalesce(jsonb_agg(to_jsonb(_operator_ro_row)), ''[]''::jsonb) from (%s) as _operator_ro_row', q)
    into result;
  return result;
end;
$$;

comment on function public.operator_readonly_query(text) is
  'VTID-04624: Operator Console read-only SQL (dev_run_sql_readonly). service_role only; read-only transaction; lock_timeout 2s; 8s statement cap via authenticator.';

revoke all on function public.operator_readonly_query(text) from public;
revoke all on function public.operator_readonly_query(text) from anon;
revoke all on function public.operator_readonly_query(text) from authenticated;
grant execute on function public.operator_readonly_query(text) to service_role;
