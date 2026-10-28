-- VTID-04765 — account deletion erases every table that holds the user's rows.
--
-- request-account-deletion (vitana-v1 edge function) deleted a hand-kept list
-- of 20 tables, then the auth user. Every other public table whose user_id has
-- no ON DELETE CASCADE to auth.users kept the deleted member's data: measured
-- 2026-10-01 on the live schema, ~200 tables, among them memory_facts,
-- memory_items, mem_facts, memory_transcript_turns, user_assistant_state,
-- diary_entries, health_features_daily, vitana_index_scores, biomarker and
-- wearable tables, calendar_events and user_notifications. A hand-kept list
-- goes stale the day a new table ships, so this function does not keep one.
--
-- erase_user_data(user_id) finds the tables itself: every ordinary or
-- partitioned table in schema public with a uuid column named user_id
-- (partitions are reached through their parent), except tables whose
-- user_id already cascades from auth.users: those go when the auth user is
-- deleted, exactly as before, and deleting them early would trip foreign
-- keys from tables that have no user_id (wallet_transactions -> profiles,
-- tenant_autopilot_* -> app_users). It deletes the user's rows
-- from each, except the tables listed in erasure_registry with the action
-- 'retain' and a written reason (legal retention). A delete that hits a
-- foreign key is retried after the others, for up to 5 passes, so child rows
-- go first without anyone maintaining an order. Each table runs in its own
-- sub-transaction: one failure is reported, it does not abort the rest.
--
-- Returns jsonb { deleted: {table: rows}, retained: [table], errors:
-- {table: message}, passes }. The caller (request-account-deletion) must not
-- delete the auth user while errors is non-empty: the rows would stay behind
-- with no account to erase them from.
--
-- p_dry_run => counts the rows instead of deleting them.
--
-- Not covered here, by design: columns other than user_id (sender_id,
-- author_id, ...), which the edge function still handles by its own list;
-- storage buckets (edge function); vacuuming deleted vector pages (autovacuum).
--
-- service_role only.

create table if not exists public.erasure_registry (
  table_name text primary key,
  action text not null check (action in ('retain')),
  reason text not null check (length(btrim(reason)) > 0),
  created_at timestamptz not null default now()
);

alter table public.erasure_registry enable row level security;
revoke all on public.erasure_registry from public, anon, authenticated;
grant select, insert, update, delete on public.erasure_registry to service_role;

comment on table public.erasure_registry is
  'VTID-04765: tables erase_user_data() keeps on account deletion, each with the legal reason. Every other public table with a user_id column is erased.';

-- Financial records kept for the statutory retention period (HGB §257,
-- AO §147). To be confirmed by counsel; deleting a row here re-enables
-- erasure for that table.
insert into public.erasure_registry (table_name, action, reason) values
  ('wallet_accounts',         'retain', 'Account the retained ledger rows reference (wallet_ledger_entries, wallet_deposits FKs)'),
  ('wallet_ledger_entries',   'retain', 'Financial ledger: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('wallet_deposits',         'retain', 'Payment record: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('wallet_credits',          'retain', 'Financial ledger: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('commission_event',        'retain', 'Commission accounting: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('product_orders',          'retain', 'Order record: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('cart_order',              'retain', 'Order record: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('checkout_sessions',       'retain', 'Payment record: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('user_subscriptions',      'retain', 'Billing record: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('rewards_ledger',          'retain', 'Financial ledger: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('redemption_redemptions',  'retain', 'Voucher redemption record: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('monetization_audit',      'retain', 'Payment audit: statutory bookkeeping retention (HGB §257, AO §147)'),
  ('notification_test_actors','retain', 'Test-account allowlist (VTID-03506); not member data'),
  ('service_bot_accounts',    'retain', 'Service-account allowlist (VTID-03990); not member data')
on conflict (table_name) do nothing;

create or replace function public.erase_user_data(p_user_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tables   text[];
  v_pending  text[];
  v_next     text[];
  v_retained text[];
  v_deleted  jsonb := '{}'::jsonb;
  v_errors   jsonb := '{}'::jsonb;  -- foreign-key failures of the last pass
  v_failed   jsonb := '{}'::jsonb;  -- other failures, not retried
  v_table    text;
  v_rows     bigint;
  v_pass     int := 0;
  v_progress boolean;
begin
  if p_user_id is null then
    raise exception 'erase_user_data: p_user_id is required';
  end if;

  select coalesce(array_agg(r.table_name order by r.table_name), '{}')
    into v_retained
    from public.erasure_registry r
   where r.action = 'retain';

  select coalesce(array_agg(c.relname::text order by c.relname), '{}')
    into v_tables
    from pg_class c
    join pg_attribute a on a.attrelid = c.oid
   where c.relnamespace = 'public'::regnamespace
     and c.relkind in ('r', 'p')
     and not c.relispartition
     and a.attname = 'user_id'
     and a.attnum > 0
     and not a.attisdropped
     and a.atttypid = 'uuid'::regtype
     and c.relname <> 'erasure_registry'
     and not exists (
       select 1 from pg_constraint con
        where con.conrelid = c.oid
          and con.contype = 'f'
          and con.confrelid = 'auth.users'::regclass
          and con.confdeltype = 'c'
          and a.attnum = any (con.conkey));

  v_pending := array(select t from unnest(v_tables) t where t <> all (v_retained));

  -- Delete triggers can write new rows for this user (audit logs), so keep
  -- sweeping until a pass removes nothing and nothing is left pending.
  loop
    v_pass := v_pass + 1;
    v_next := '{}';
    v_progress := false;
    v_errors := '{}'::jsonb;

    foreach v_table in array v_pending loop
      begin
        if p_dry_run then
          execute format('select count(*) from public.%I where user_id = $1', v_table)
            into v_rows using p_user_id;
        else
          execute format('delete from public.%I where user_id = $1', v_table)
            using p_user_id;
          get diagnostics v_rows = row_count;
        end if;
        if v_rows > 0 then
          v_deleted := jsonb_set(v_deleted, array[v_table],
            to_jsonb(coalesce((v_deleted ->> v_table)::bigint, 0) + v_rows));
          v_progress := true;
        end if;
        if not p_dry_run then
          v_next := v_next || v_table;  -- swept again next pass
        end if;
      exception
        when foreign_key_violation then
          v_next := v_next || v_table;
          v_errors := v_errors || jsonb_build_object(v_table, sqlerrm);
        when others then
          v_failed := v_failed || jsonb_build_object(v_table, sqlerrm);
      end;
    end loop;

    exit when p_dry_run;
    exit when not v_progress;
    exit when v_pass >= 5;
    v_pending := v_next;
  end loop;

  return jsonb_build_object(
    'user_id', p_user_id,
    'dry_run', p_dry_run,
    'passes', v_pass,
    'deleted', v_deleted,
    'retained', to_jsonb(v_retained),
    'errors', v_errors || v_failed
  );
end;
$$;

revoke all on function public.erase_user_data(uuid, boolean) from public, anon, authenticated;
grant execute on function public.erase_user_data(uuid, boolean) to service_role;

comment on function public.erase_user_data(uuid, boolean) is
  'VTID-04765: deletes the user''s rows from every public table with a uuid user_id column, except erasure_registry retain entries. Returns {deleted, retained, errors, passes}. Called by request-account-deletion before the auth user is deleted.';
