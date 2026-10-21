#!/usr/bin/env bash
# VTID-05168: runs the Vitana Index movements test against a throwaway database,
# then a two-connection concurrency check: while session A holds a recompute
# open, session B changes a different pillar and recomputes. With the per-member
# advisory lock each movement carries only its own change; without it B's
# "before" is stale and its delta swallows A's change.
# Needs PG* env vars (or a local socket) pointing at a disposable Postgres.
# Refuses to run against anything that looks like Supabase or Aurora.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
db="index_movements_test_$$"
createdb "$db"
trap 'dropdb --if-exists "$db"' EXIT
cd "$(dirname "$0")"
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f vtid-05168-index-movements.test.sql

U2="'22222222-2222-2222-2222-222222222222'"
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "update public.t_points set h = 50 where user_id = $U2"
psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null <<SQL &
begin;
select public.vitana_index_recompute_and_record($U2, current_date, 'voice_log', 'session', 'a');
select pg_sleep(3);
commit;
SQL
A=$!
sleep 1
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "update public.t_points set e = 55 where user_id = $U2"
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "select public.vitana_index_recompute_and_record($U2, current_date, 'manual_log', 'session', 'b')" >/dev/null
wait "$A"

psql -X -q -v ON_ERROR_STOP=1 -d "$db" <<SQL
do \$\$
declare a record; b record;
begin
  select * into a from public.vitana_index_movements where user_id = $U2 and source_ref = 'a';
  select * into b from public.vitana_index_movements where user_id = $U2 and source_ref = 'b';
  if a.id is null or b.id is null then raise exception 'concurrency: missing movement (a=%, b=%)', a.id, b.id; end if;
  if (a.delta_pillars->>'hydration')::int <> 10 or (a.delta_pillars->>'exercise')::int <> 0
    then raise exception 'concurrency: A must carry only hydration +10: %', a.delta_pillars; end if;
  if (b.delta_pillars->>'exercise')::int <> 15 or (b.delta_pillars->>'hydration')::int <> 0
    then raise exception 'concurrency: B must carry only exercise +15 (stale before?): %', b.delta_pillars; end if;
  if (b.before->>'hydration')::int <> 50 then raise exception 'concurrency: B must start from A''s result'; end if;
end
\$\$;
SQL
echo 'PASS vtid-05168 index movements'
