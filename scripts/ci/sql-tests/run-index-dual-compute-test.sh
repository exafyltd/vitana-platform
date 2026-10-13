#!/usr/bin/env bash
# VTID-05163: runs the Vitana Index dual-compute test against throwaway
# databases. Needs PG* env vars (or a local socket) pointing at a disposable
# Postgres. Refuses to run against anything that looks like Supabase or Aurora.
#
#   0. Extracts the LIVE Index functions — health_compute_vitana_index_for_user
#      and vitana_pillar_streak_days — verbatim from the NEWEST migration that
#      defines each (so a later migration that changes the live formula is the
#      one compared), plus every migration that defines them is listed in the
#      workflow's path triggers (asserted by a Jest test).
#   1. vtid-05163-index-dual-compute.test.sql — the functional drift guard
#      (identical rows in health_features_daily and health_features_daily_v2
#      must give the live result for every (p_device_from, p_self_from)), the
#      key-class routing, STABLE, grants, the dual-compute table, erasure.
#   2. The rollback data fix-up (Change 14): restores shadow rows, removes
#      orphan derived_v2 rows, per mode; refuses without its two settings; and
#      rolls back ENTIRELY when its post-condition guard fails.
#   3. Placement guard — the migration refuses a Supabase-shaped database and a
#      database without health_features_daily_v2, leaving nothing behind.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
M=../../../supabase/migrations
B3=$M/20261014100800_vtid_05163_index_dual_compute.sql
ROLLBACK=$M/data-fixups/20261014100900_vtid_05163_rollback_health_features.sql
work=$(mktemp -d)
dbs=()
cleanup() { for d in "${dbs[@]}"; do dropdb --if-exists "$d"; done; rm -rf "$work"; }
trap cleanup EXIT
newdb() { local d="index_dual_compute_test_$$_$1"; createdb "$d"; dbs+=("$d"); echo "$d"; }

# 0. Extract the live functions from the newest migration defining each.
extract() {
  local fn="$1" file
  file=$(grep -l "CREATE OR REPLACE FUNCTION public\.${fn}(" $M/*.sql | sort | tail -n 1)
  [ -n "$file" ] || { echo "FAIL: no migration defines ${fn}" >&2; exit 1; }
  echo "-- ${fn} from $(basename "$file")"
  awk -v fn="CREATE OR REPLACE FUNCTION public.${fn}(" '
    index($0, fn) == 1 { on = 1 }
    on { print }
    on && /^\$\$;[[:space:]]*$/ { exit }
  ' "$file"
}
{
  extract vitana_pillar_streak_days
  extract health_compute_vitana_index_for_user
} > "$work/live-functions.sql"
grep -q 'INSERT INTO public.vitana_index_scores' "$work/live-functions.sql" || { echo "FAIL: live _for_user not extracted" >&2; exit 1; }
grep -c '^\$\$;' "$work/live-functions.sql" | grep -qx 2 || { echo "FAIL: expected two complete function bodies" >&2; exit 1; }
head -n 1 "$work/live-functions.sql"; sed -n '/^-- health_compute/p' "$work/live-functions.sql"

# 1. Main test.
db=$(newdb main)
PGOPTIONS='-c vitana.health_store_target=aurora' psql -X -q -v ON_ERROR_STOP=1 -v live_fns="$work/live-functions.sql" -d "$db" -f vtid-05163-index-dual-compute.test.sql

# 2. Rollback fix-up, on the same database (it has health_features_daily + the shadow).
q() { psql -X -q -At -v ON_ERROR_STOP=1 -d "$db" -c "$1"; }
fixture() {
  q "set client_min_messages = warning; delete from public.health_features_daily; delete from public.health_features_daily_legacy_shadow;
     drop trigger if exists t_tamper on public.health_features_daily;
     insert into public.health_features_daily (tenant_id, user_id, date, feature_key, feature_value, metadata) values
       -- in scope, derived, shadow exists -> replaced by the shadow row
       ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','2026-11-02','wearable_steps',9000,'{\"source\":\"derived_v2\"}'),
       -- in scope, derived, no shadow -> deleted
       ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','2026-11-03','wearable_hrv',50,'{\"source\":\"derived_v2\"}'),
       -- before C -> untouched
       ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','2026-10-30','wearable_steps',7000,'{\"source\":\"derived_v2\"}'),
       -- a self-logged coded key, derived -> deleted only in mode derived
       ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','2026-11-02','meal_log',2,'{\"source\":\"derived_v2\"}'),
       -- a member's own row in scope, not derived -> untouched
       ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','2026-11-04','wearable_heart_rate',61,'{\"source\":\"voice_tool_vitals\"}'),
       -- a key with no store code -> never touched
       ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','2026-11-02','biomarker_glucose',95,'{\"source\":\"derived_v2\"}');
     insert into public.health_features_daily_legacy_shadow (tenant_id, user_id, date, feature_key, feature_value, metadata) values
       ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','2026-11-02','wearable_steps',8800,'{\"source\":\"wearable_bridge\"}'),
       -- a shadow row whose live row is missing -> inserted
       ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','2026-11-05','wearable_workout',1,'{\"source\":\"wearable_bridge\"}'),
       ('10000000-0000-0000-0000-000000000001','a0000000-0000-0000-0000-00000000000a','2026-11-02','meal_log',3,'{\"source\":\"diary_extractor\"}');" >/dev/null
}
state() { q "select string_agg(date || ':' || feature_key || ':' || feature_value || ':' || coalesce(metadata->>'source',''), ',' order by date, feature_key) from public.health_features_daily"; }
run_rollback() { PGOPTIONS="$1" psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$ROLLBACK" 2>&1; }

fixture
before=$(state)
if out=$(run_rollback ''); then echo "FAIL: rollback ran without its settings" >&2; exit 1; fi
echo "$out" | grep -q 'SET vitana.health_features_rollback_mode' || { echo "FAIL: unexpected error: $out" >&2; exit 1; }
[ "$(state)" = "$before" ] || { echo "FAIL: a refused rollback changed rows" >&2; exit 1; }
if out=$(run_rollback '-c vitana.health_features_rollback_mode=derived_device'); then echo "FAIL: rollback ran without a date" >&2; exit 1; fi
[ "$(state)" = "$before" ] || { echo "FAIL: a refused rollback changed rows" >&2; exit 1; }

run_rollback '-c vitana.health_features_rollback_mode=derived_device -c vitana.health_features_rollback_date=2026-11-01' >/dev/null
got=$(state)
want='2026-10-30:wearable_steps:7000:derived_v2,2026-11-02:biomarker_glucose:95:derived_v2,2026-11-02:meal_log:2:derived_v2,2026-11-02:wearable_steps:8800:wearable_bridge,2026-11-04:wearable_heart_rate:61:voice_tool_vitals,2026-11-05:wearable_workout:1:wearable_bridge'
[ "$got" = "$want" ] || { echo "FAIL: derived_device rollback state: $got" >&2; exit 1; }
# Idempotent: a second run changes nothing.
run_rollback '-c vitana.health_features_rollback_mode=derived_device -c vitana.health_features_rollback_date=2026-11-01' >/dev/null
[ "$(state)" = "$want" ] || { echo "FAIL: second derived_device rollback changed rows" >&2; exit 1; }

fixture
run_rollback '-c vitana.health_features_rollback_mode=derived -c vitana.health_features_rollback_date=2026-11-01' >/dev/null
got=$(state)
want='2026-10-30:wearable_steps:7000:derived_v2,2026-11-02:biomarker_glucose:95:derived_v2,2026-11-02:meal_log:3:diary_extractor,2026-11-02:wearable_steps:8800:wearable_bridge,2026-11-04:wearable_heart_rate:61:voice_tool_vitals,2026-11-05:wearable_workout:1:wearable_bridge'
[ "$got" = "$want" ] || { echo "FAIL: derived rollback state: $got" >&2; exit 1; }

# Guard failure: a trigger tampers with restored rows -> post-condition fails -> nothing changed.
fixture
q "create or replace function t_tamper() returns trigger language plpgsql as \$t\$ begin new.feature_value := new.feature_value + 1; return new; end \$t\$;
   create trigger t_tamper before insert or update on public.health_features_daily for each row execute function t_tamper();" >/dev/null
before=$(state)
if out=$(run_rollback '-c vitana.health_features_rollback_mode=derived_device -c vitana.health_features_rollback_date=2026-11-01'); then
  echo "FAIL: rollback committed although its post-condition failed" >&2; exit 1
fi
echo "$out" | grep -q 'rollback post-condition failed' || { echo "FAIL: unexpected error: $out" >&2; exit 1; }
[ "$(state)" = "$before" ] || { echo "FAIL: a failed rollback left partial changes" >&2; exit 1; }
q "drop trigger t_tamper on public.health_features_daily" >/dev/null
echo 'PASS vtid-05163 rollback fix-up'

# 3. Placement guard.
PRE="do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end \$\$;
create schema if not exists auth;
create table auth.users (id uuid primary key);
create schema storage; create table storage.objects (id uuid primary key);"
objects() { psql -X -q -At -d "$1" -c "select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'vitana_index_dual%') + (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and (proname like '%projected%' or proname = 'vitana_index_project_for_user'))"; }

db=$(newdb supa)
psql -X -q -v ON_ERROR_STOP=1 -d "$db" -c "$PRE" >/dev/null
if out=$(psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$B3" 2>&1); then
  echo "FAIL: dual-compute migration applied on a Supabase-shaped database" >&2; exit 1
fi
echo "$out" | grep -q 'VTID-05163 health store placement guard' || { echo "FAIL: unexpected error: $out" >&2; exit 1; }
objects "$db" | grep -qx 0 || { echo "FAIL: refused migration left objects behind" >&2; exit 1; }

# Aurora override but no health_features_daily_v2 -> refused too.
if out=$(PGOPTIONS='-c vitana.health_store_target=aurora' psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$B3" 2>&1); then
  echo "FAIL: dual-compute migration applied without health_features_daily_v2" >&2; exit 1
fi
echo "$out" | grep -q 'health_features_daily_v2 is missing' || { echo "FAIL: unexpected error: $out" >&2; exit 1; }
objects "$db" | grep -qx 0 || { echo "FAIL: refused migration left objects behind" >&2; exit 1; }
echo 'PASS vtid-05163 placement guard'
