#!/usr/bin/env bash
# rehearse-restore.sh — runs the EXACT restore of restore-sparring.manifest on a disposable local PostgreSQL 17
# that imitates Aurora staging's roles, then the functional checks the gateway path needs, the atomicity check and
# the rollback. Never connects to any AWS database.
#
# Aurora imitation (docs.aws.amazon.com, "Understanding the rds_superuser role"): the master user is
#   LOGIN NOSUPERUSER INHERIT CREATEDB CREATEROLE, member of rds_superuser, owner of database vitana;
#   it has no BYPASSRLS. `authenticator` exists (LOGIN NOINHERIT, no other attribute: VTID-05803 privilege probe).
#
# Usage: rehearse-restore.sh --repo <vitana-platform checkout> --pgbin <dir with initdb/pg_ctl/psql> [--postgrest <postgrest 12.2.3 binary>] [--out <file>]
# Run as an unprivileged user (initdb refuses root).
set -euo pipefail
REPO=""; PGBIN=""; OUT=/dev/stdout; PGRST=""
while [ $# -gt 0 ]; do case "$1" in --repo) REPO="$2"; shift;; --pgbin) PGBIN="$2"; shift;; --out) OUT="$2"; shift;; --postgrest) PGRST="$2"; shift;; *) echo "unknown $1" >&2; exit 2;; esac; shift; done
[ -n "$REPO" ] && [ -n "$PGBIN" ] || { echo "usage: --repo <dir> --pgbin <dir>" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
export PATH="$PGBIN:$PATH"
W=$(mktemp -d); PORT=55433
trap 'pg_ctl -D "$W/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$W"' EXIT
exec > >(tee "$OUT") 2>&1

pass=0; fail=0
ok()   { echo "PASS  $*"; pass=$((pass+1)); }
bad()  { echo "FAIL  $*"; fail=$((fail+1)); }
expect() { # expect <label> <wanted> <actual>
  if [ "$2" = "$3" ]; then ok "$1 = $3"; else bad "$1: wanted '$2', got '$3'"; fi; }

echo "== rehearsal $(date -u +%FT%TZ) on $(postgres --version)"
echo "== manifest"
FILES=()
while read -r sum path; do
  case "$sum" in ''|\#*) continue;; esac
  f="$REPO/$path"; [ -f "$f" ] || { bad "missing $path"; continue; }
  got=$(sha256sum "$f" | cut -c1-64)
  if [ "$sum" = "$got" ]; then echo "  $got  $path"; FILES+=("$f"); else bad "checksum $path"; fi
done < "$HERE/restore-sparring.manifest"

initdb -D "$W/data" -U postgres -A trust --no-sync >/dev/null
pg_ctl -D "$W/data" -o "-k $W -p $PORT -c listen_addresses=''" -l "$W/log" -w start >/dev/null
SU=(psql -h "$W" -p $PORT -U postgres -XAtq -v ON_ERROR_STOP=1)

aurora_like() { # aurora_like <db> [preexisting roles...]
  local db=$1; shift
  "${SU[@]}" -d postgres <<SQL
DROP DATABASE IF EXISTS $db;
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rds_superuser') THEN CREATE ROLE rds_superuser NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vitana_staging_admin') THEN
    CREATE ROLE vitana_staging_admin LOGIN NOSUPERUSER INHERIT CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT rds_superuser TO vitana_staging_admin;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator LOGIN NOINHERIT; END IF;
END \$\$;
CREATE DATABASE $db OWNER vitana_staging_admin;
SQL
  for r in "$@"; do "${SU[@]}" -d postgres -c "CREATE ROLE $r NOLOGIN NOINHERIT" ; done
  "${SU[@]}" -d "$db" -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
}
clean_roles() { # a fresh start: drop the rehearsal databases (and with them every privilege), then the roles
  local d; for d in vitana; do "${SU[@]}" -d postgres -c "DROP DATABASE IF EXISTS $d" >/dev/null 2>&1; done
  "${SU[@]}" -d postgres -c "DROP ROLE IF EXISTS anon, authenticated, service_role, vitana_governance_owner" >/dev/null; }
# Catalog snapshot of everything the restore or the rollback could touch (database + cluster-wide objects).
snapshot() { _snapshot | LC_ALL=C sort; }
_snapshot() { psql -h "$W" -p $PORT -U postgres -d vitana -XAtq <<'SQL'
select 'schema '||nspname||' acl='||coalesce(nspacl::text,'') from pg_namespace where nspname not like 'pg\_%' and nspname <> 'information_schema'
union all select 'rel '||n.nspname||'.'||c.relname||' kind='||c.relkind::text from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
union all select 'func '||p.oid::regprocedure::text||' acl='||coalesce(p.proacl::text,'') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not like 'pg\_%' and n.nspname <> 'information_schema'
union all select 'policy '||polrelid::regclass::text||'.'||polname from pg_policy
union all select 'trigger '||tgrelid::regclass::text||'.'||tgname from pg_trigger where not tgisinternal
union all select 'role '||rolname||' login='||rolcanlogin::text||' bypassrls='||rolbypassrls::text from pg_roles where rolname not like 'pg\_%'
union all select 'member '||pg_get_userbyid(roleid)||' -> '||pg_get_userbyid(member)||' admin='||admin_option::text from pg_auth_members where pg_get_userbyid(member) not like 'pg\_%'
union all select 'default_acl '||defaclrole::regrole::text||' '||defaclobjtype::text from pg_default_acl
union all select 'database_acl '||coalesce(datacl::text,'') from pg_database where datname='vitana'
union all select 'role_comment '||count(*)::text from pg_shdescription where classoid='pg_authid'::regclass
order by 1;
SQL
}
M=(psql -h "$W" -p $PORT -U vitana_staging_admin -X)
# The same invocation as restore-sparring-schema.sh --apply: precheck, then every manifest file in order, stop on the
# first error. Not one transaction: three migrations carry their own BEGIN/COMMIT, so a failure is undone by the
# rollback file (section C proves it).
apply() { "${M[@]}" -d "$1" -q -v ON_ERROR_STOP=1 -f "$HERE/precheck-sparring.sql" $(printf -- '-f %q ' "${FILES[@]}") >"$W/apply-$1.log" 2>&1; }
RB=(-v drop_roles=anon,authenticated,service_role,vitana_governance_owner -v revoke_memberships=anon,authenticated,service_role -v revoke_usage=anon,authenticated,service_role -v drop_schemas= -f "$HERE/rollback-sparring-schema.sql")
# The same pre-state the live --apply records (prestate-sparring.sql), and the rollback the live --rollback replays.
prestate() { "${M[@]}" -d vitana -XAt -f "$HERE/prestate-sparring.sql"; }
rollback_from() { local c m u; IFS='|' read -r c m u <<<"$1"
  "${M[@]}" -d vitana -q -v drop_roles="$c" -v revoke_memberships="$m" -v revoke_usage="$u" -v drop_schemas= -f "$HERE/rollback-sparring-schema.sql"; }
live_like_case() { # live_like_case <label> <grant-usage yes|no>
  echo; echo "== $1"
  clean_roles; aurora_like vitana
  "${SU[@]}" -d postgres -c "CREATE ROLE anon NOLOGIN NOINHERIT" -c "CREATE ROLE authenticated NOLOGIN NOINHERIT" \
    -c "CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS" -c "GRANT anon, authenticated, service_role TO authenticator"
  [ "$2" = yes ] && "${SU[@]}" -d vitana -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role"
  snapshot > "$W/l0"
  local pre; pre=$(prestate); echo "  prestate (created|revoke_memberships|revoke_usage): $pre"
  if apply vitana; then ok "precheck passed and all 7 files applied (request roles pre-existing, not created by the master)"; else bad "apply: $(grep -m1 -E 'ERROR|refused' "$W/apply-vitana.log")"; fi
  expect "service_role (pre-existing) inserts and reads a session through authenticator" "1" \
    "$(q authenticator vitana "SET ROLE service_role; insert into plan_sparring_sessions (plan_id, plan_hash, producer, change_class, trust_tier) values (gen_random_uuid(), repeat('c',64), 'rehearsal', 'standard', 'gateway'); select count(*) from plan_sparring_sessions")"
  expect "anon (pre-existing) cannot read vtid_ledger" "ERROR:  permission denied for table vtid_ledger" "$(q authenticator vitana "SET ROLE anon; select count(*) from vtid_ledger")"
  snapshot > "$W/l1"
  echo "  catalog entries added: $(LC_ALL=C comm -13 "$W/l0" "$W/l1" | wc -l | tr -d ' '); pre-existing entries modified: $(LC_ALL=C comm -23 "$W/l0" "$W/l1" | awk '{print $1" "$2}' | tr '\n' ';')"
  rollback_from "$pre" >"$W/rb-l.log" 2>&1 && ok "rollback replayed the recorded pre-state" || bad "rollback: $(grep -m1 ERROR "$W/rb-l.log")"
  snapshot > "$W/l2"
  expect "catalog after rollback identical to before (pre-existing roles, memberships and grants kept)" "0" "$(diff "$W/l0" "$W/l2" | grep -c '^[<>]' || true)"
  expect "pre-existing request roles still exist" "3" "$(q postgres vitana "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')")"
  expect "authenticator memberships unchanged" "anon,authenticated,service_role" "$(q postgres vitana "select string_agg(r.rolname, ',' order by r.rolname) from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member where u.rolname='authenticator'")"
  expect "re-apply after rollback" "ok" "$(apply vitana && echo ok || grep -m1 ERROR "$W/apply-vitana.log")"
}
q() { psql -h "$W" -p $PORT -U "$1" -d "$2" -XAtq -c "$3" 2>&1 | tail -1; }

echo; echo "== A. empty database, roles absent (expected Aurora staging state), master without BYPASSRLS"
clean_roles; aurora_like vitana
snapshot > "$W/s0"; expect "snapshot before apply is readable" "yes" "$([ -s "$W/s0" ] && ! grep -q ERROR "$W/s0" && echo yes || echo no)"
if apply vitana; then ok "precheck passed and all 7 files applied"; else bad "restore failed: $(grep -m1 ERROR "$W/apply-vitana.log")"; fi
expect "public tables" "plan_sparring_config,plan_sparring_sessions,plan_sparring_shadow_log,pm_digests,pm_lease,vtid_ledger" \
  "$(q postgres vitana "select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname='public'")"
expect "roles created (name:login:bypassrls)" "anon:false:false,authenticated:false:false,service_role:false:false,vitana_governance_owner:false:false" \
  "$(q postgres vitana "select string_agg(rolname||':'||rolcanlogin||':'||rolbypassrls, ',' order by rolname) from pg_roles where rolname in ('anon','authenticated','service_role','vitana_governance_owner')")"
expect "no auth/storage/extensions schema created" "0" "$(q postgres vitana "select count(*) from pg_namespace where nspname in ('auth','storage','extensions')")"
expect "authenticator member of" "anon,authenticated,service_role" \
  "$(q postgres vitana "select string_agg(r.rolname, ',' order by r.rolname) from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member where u.rolname='authenticator'")"
expect "gate trigger on vtid_ledger" "1" "$(q postgres vitana "select count(*) from pg_trigger where tgname='trg_plan_sparring_check' and not tgisinternal")"
expect "plan_sparring_config mode" "log" "$(q postgres vitana "select mode from plan_sparring_config")"
expect "system_controls absent (allocator reads no row -> disabled)" "t" "$(q postgres vitana "select to_regclass('public.system_controls') is null")"
expect "global_vtid_seq untouched (migration default)" "1000" "$(q postgres vitana "select start_value from pg_sequences where sequencename='global_vtid_seq'")"

echo; echo "== A2. gateway path through PostgREST's role switch (authenticator -> service_role)"
SR="SET ROLE service_role;"
SID=$(q authenticator vitana "$SR insert into plan_sparring_sessions (plan_id, plan_hash, producer, change_class, trust_tier, base_ref, approval_policy) values (gen_random_uuid(), repeat('a',64), 'ci-plan-spar.rehearsal', 'standard', 'gateway', 'main', 'converged-auto-v1') returning id")
[[ "$SID" =~ ^[0-9a-f-]{36}$ ]] && ok "service_role inserts a sparring session ($SID)" || bad "insert: $SID"
expect "service_role reads it" "1" "$(q authenticator vitana "$SR select count(*) from plan_sparring_sessions where id='$SID'")"
R1=$(q authenticator vitana "$SR select plan_sparring_append_round('$SID', '{\"n\":1,\"findings\":[]}'::jsonb, 1)->>'ok'")
expect "plan_sparring_append_round round 1" "true" "$R1"
expect "converge + policy approval (UPDATE as service_role)" "UPDATE 1" \
  "$(psql -h "$W" -p $PORT -U authenticator -d vitana -X -c "$SR update plan_sparring_sessions set verdict='converged', final_plan_hash=repeat('a',64), policy_approved_at=now(), policy_approval_rule='converged-auto-v1' where id='$SID'" 2>&1 | tail -1)"
expect "vtid_ledger rows (nothing allocated)" "0" "$(q authenticator vitana "$SR select count(*) from vtid_ledger")"
expect "anon cannot read vtid_ledger" "ERROR:  permission denied for table vtid_ledger" "$(q authenticator vitana "SET ROLE anon; select count(*) from vtid_ledger")"
expect "anon cannot read sparring sessions" "ERROR:  permission denied for table plan_sparring_sessions" "$(q authenticator vitana "SET ROLE anon; select count(*) from plan_sparring_sessions")"
expect "authenticated cannot read sparring sessions" "ERROR:  permission denied for table plan_sparring_sessions" "$(q authenticator vitana "SET ROLE authenticated; select count(*) from plan_sparring_sessions")"
expect "anon cannot call the allocator" "ERROR:  permission denied for function allocate_global_vtid" "$(q authenticator vitana "SET ROLE anon; select allocate_global_vtid('x','DEV','X')")"
expect "authenticator itself (no role switch) reads nothing" "ERROR:  permission denied for table plan_sparring_sessions" "$(q authenticator vitana "select count(*) from plan_sparring_sessions")"

snapshot > "$W/s1"; expect "snapshot after apply is readable" "yes" "$([ -s "$W/s1" ] && [ "$(wc -l < "$W/s1")" -gt "$(wc -l < "$W/s0")" ] && echo yes || echo no)"
echo; echo "== F. exact rollback scope: every catalog entry the restore added (diff of snapshots before/after apply)"
LC_ALL=C comm -13 "$W/s0" "$W/s1" | sed 's/^/  + /'
echo "  pre-existing entries the restore modified (old value shown):"; LC_ALL=C comm -23 "$W/s0" "$W/s1" | sed 's/^/  ~ /'
expect "pre-existing entries modified (only schema public ACL and the shared role-comment count)" "role_comment schema" \
  "$(LC_ALL=C comm -23 "$W/s0" "$W/s1" | awk '{print $1}' | sort | tr '\n' ' ' | sed 's/ $//')"

echo; echo "== A3. rollback"
"${M[@]}" -d vitana -q "${RB[@]}" >"$W/rollback.log" 2>&1 && ok "rollback ran" || bad "rollback: $(grep -m1 ERROR "$W/rollback.log")"
expect "public tables after rollback" "0" "$(q postgres vitana "select count(*) from pg_tables where schemaname='public'")"
expect "restore roles after rollback" "0" "$(q postgres vitana "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','vitana_governance_owner')")"
expect "authenticator kept" "1" "$(q postgres vitana "select count(*) from pg_roles where rolname='authenticator'")"
snapshot > "$W/s2"
expect "catalog after rollback identical to before the restore (lines differing)" "0" "$(diff "$W/s0" "$W/s2" | grep -c '^[<>]' || true)"
expect "re-apply after rollback" "ok" "$(apply vitana && echo ok || grep -m1 ERROR "$W/apply-vitana.log")"

echo; echo "== D. a non-empty database is refused before anything runs"
apply vitana && bad "second apply on a restored database ran" || expect "precheck refusal" "refused: public schema has tables; this restore only runs on the empty staging database" "$(grep -m1 -o 'refused: .*' "$W/apply-vitana.log")"

live_like_case "L1. live state (2026-11-18 dry run): request roles pre-exist, authenticator already their member, USAGE on public granted" yes
live_like_case "L2. same, without explicit USAGE grants on public" no

echo; echo "== B. a pre-existing request role authenticator is NOT a member of, and no ADMIN OPTION for the master"
clean_roles; aurora_like vitana anon authenticated service_role
apply vitana && bad "restore ran although the grant to authenticator cannot succeed" \
  || expect "precheck refusal" "refused: role anon exists, authenticator is not its member, and vitana_staging_admin has no ADMIN OPTION to grant it" "$(grep -m1 -o 'refused: .*' "$W/apply-vitana.log")"
expect "nothing created" "0" "$(q postgres vitana "select count(*) from pg_tables where schemaname='public'")"

echo; echo "== C. a failure in the last file, then the rollback file, returns to the empty state"
clean_roles; aurora_like vitana
PRE_C=$(prestate)
cp "$HERE/restore-sparring-grants.sql" "$W/grants-broken.sql"; echo "SELECT 1/0;" >> "$W/grants-broken.sql"
FILES_SAVE=("${FILES[@]}"); FILES[-1]="$W/grants-broken.sql"
apply vitana && bad "broken restore succeeded" || ok "broken restore stopped at the injected error ($(grep -m1 -o 'division by zero' "$W/apply-vitana.log"))"
FILES=("${FILES_SAVE[@]}")
echo "  partial state after the failure: $(q postgres vitana "select count(*) from pg_tables where schemaname='public'") tables (migrations commit file by file)"
rollback_from "$PRE_C" >"$W/rb-c.log" 2>&1 && ok "rollback ran after the failure" || bad "rollback C: $(grep -m1 ERROR "$W/rb-c.log")"
expect "public tables after rollback" "0" "$(q postgres vitana "select count(*) from pg_tables where schemaname='public'")"
expect "restore roles after rollback" "0" "$(q postgres vitana "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role','vitana_governance_owner')")"
expect "authenticator memberships after rollback" "0" "$(q postgres vitana "select count(*) from pg_auth_members m join pg_roles u on u.oid=m.member where u.rolname='authenticator'")"
expect "apply after rollback" "ok" "$(apply vitana && echo ok || grep -m1 ERROR "$W/apply-vitana.log")"

if [ -n "$PGRST" ]; then
  echo; echo "== E. PostgREST $("$PGRST" --version | tr -d '\n') on the restored database (the proxy's container; JWT behaviour of revision 21)"
  STAGING_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/')   # stands in for vitana/gateway/staging/postgrest-jwt-secret
  OTHER_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n=+/')     # stands in for the production Supabase JWT secret
  mint() { SECRET="$1" ROLE="$2" node -e '
    const c=require("crypto"); const b=(o)=>Buffer.from(JSON.stringify(o)).toString("base64url"); const now=Math.floor(Date.now()/1000);
    const h=b({alg:"HS256",typ:"JWT"}), p=b({role:process.env.ROLE,iss:"vitana-aurora-staging",aud:"preview-sparring",iat:now,exp:now+600});
    process.stdout.write(h+"."+p+"."+c.createHmac("sha256",process.env.SECRET).update(h+"."+p).digest("base64url"));'; }
  STG=$(mint "$STAGING_SECRET" service_role); PRODLIKE=$(mint "$OTHER_SECRET" service_role); AUTHD=$(mint "$STAGING_SECRET" authenticated)
  PGRST_DB_URI="postgresql://authenticator@/vitana?host=$W&port=$PORT" PGRST_DB_SCHEMAS=public PGRST_DB_ANON_ROLE=anon \
  PGRST_JWT_SECRET="$STAGING_SECRET" PGRST_SERVER_PORT=3901 PGRST_SERVER_HOST=127.0.0.1 PGRST_DB_USE_LEGACY_GUCS=false \
    "$PGRST" >"$W/pgrst.log" 2>&1 & PGRST_PID=$!
  for i in $(seq 1 40); do curl -fs -o /dev/null http://127.0.0.1:3901/ && break; sleep 0.25; done
  echo "  $(grep -m1 -o 'Schema cache loaded.*' "$W/pgrst.log" || echo 'schema cache line not found')"
  code() { curl -s -o "$W/body" -w '%{http_code}' "$@"; }
  H=(-H "Content-Type: application/json")
  expect "staging service_role key: read sessions" "200" "$(code "${H[@]}" -H "Authorization: Bearer $STG" "http://127.0.0.1:3901/plan_sparring_sessions?limit=1")"
  expect "staging service_role key: insert a session" "201" "$(code "${H[@]}" -H "Authorization: Bearer $STG" -H 'Prefer: return=representation' \
      -d '{"plan_id":"11111111-1111-1111-1111-111111111111","plan_hash":"'"$(printf 'b%.0s' $(seq 64))"'","producer":"ci-plan-spar.rehearsal","change_class":"standard","trust_tier":"gateway","approval_policy":"converged-auto-v1"}' \
      http://127.0.0.1:3901/plan_sparring_sessions)"
  NEWID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1]))[0].id)' "$W/body" 2>/dev/null || echo none)
  expect "staging service_role key: rpc plan_sparring_append_round" "200 true" "$(code "${H[@]}" -H "Authorization: Bearer $STG" \
      -d '{"p_session":"'"$NEWID"'","p_round":{"n":1},"p_expected_round":1}' http://127.0.0.1:3901/rpc/plan_sparring_append_round) $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).ok)' "$W/body")"
  expect "a key signed with any other secret (production stand-in) is rejected" "401" "$(code "${H[@]}" -H "Authorization: Bearer $PRODLIKE" "http://127.0.0.1:3901/plan_sparring_sessions?limit=1")"
  expect "no key (anon) cannot read sessions" "401" "$(code "${H[@]}" "http://127.0.0.1:3901/plan_sparring_sessions?limit=1")"
  expect "authenticated-role key cannot read sessions" "403" "$(code "${H[@]}" -H "Authorization: Bearer $AUTHD" "http://127.0.0.1:3901/plan_sparring_sessions?limit=1")"
  expect "system_controls is not exposed (allocator reads no row -> disabled)" "404" "$(code "${H[@]}" -H "Authorization: Bearer $STG" "http://127.0.0.1:3901/system_controls?key=eq.vtid_allocator_enabled")"
  kill $PGRST_PID 2>/dev/null || true
fi

echo; echo "RESULT: $pass passed, $fail failed"
[ $fail = 0 ]
