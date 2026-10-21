-- VTID-05158 (Health Hub Phase 1 / A1, program VTID-05020) — erase_user_data()
-- works on a database without auth.users (Aurora).
-- impact-allow-solo-migration: the existing erase_user_data() callers (request-account-deletion, the nightly erasure) use this function unchanged; only its auth.users lookup becomes Aurora-safe.
--
-- APPLY TARGET: Supabase AND Aurora. On Supabase it is applied only after its
-- own Gate 2 (evidence: both SQL-ERASE-USER-DATA variants green and a
-- read-only pg_get_functiondef diff showing only the clause below changed);
-- Aurora gets it through the cutover's schema sync.
--
-- VTID-04765's body casts 'auth.users'::regclass to skip tables whose user_id
-- cascades from auth.users. Aurora has no auth.users
-- (scripts/aurora/migrations/0001_auth_shim.sql), so that cast raised
-- `relation "auth.users" does not exist` and every erase_user_data() call
-- failed there. This is the VTID-04765 function byte for byte except:
--   * v_auth_users := to_regclass('auth.users') once at the top, and
--   * the cascade exclusion becomes
--     (v_auth_users is null or not exists (... con.confrelid = v_auth_users ...)).
-- When auth.users is absent no table can have a foreign key to it, so the
-- exclusion is skipped. On Supabase to_regclass('auth.users') returns the same
-- oid the cast returned: the table list and the behaviour are identical.
-- Same signature, SECURITY DEFINER, search_path, revokes, grant and comment.
-- Not gated on the health store: it is a cutover prerequisite for all erasure.
-- Rollback: re-apply 20261001120000_vtid_04765_erase_user_data.sql's function.

BEGIN;

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
  v_auth_users regclass := to_regclass('auth.users');  -- null on Aurora (no auth.users)
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
     and (v_auth_users is null or not exists (
       select 1 from pg_constraint con
        where con.conrelid = c.oid
          and con.contype = 'f'
          and con.confrelid = v_auth_users
          and con.confdeltype = 'c'
          and a.attnum = any (con.conkey)));

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

COMMIT;
