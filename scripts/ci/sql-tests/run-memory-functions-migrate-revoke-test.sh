#!/usr/bin/env bash
# VTID-05125: runs the "revoke migrate's EXECUTE on the four memory functions"
# migration against a throwaway Postgres. Needs PG* env vars (or a local
# socket) pointing at a disposable server whose roles this script may create
# and drop (it creates anon, authenticated, service_role and migrate when they
# are missing). Refuses to run against anything that looks like Supabase or
# Aurora. Each case gets its own database; roles are cluster-wide.
#
# Cases: happy path (+ the other roles' ACL entries are untouched), idempotent
# re-apply, refusals that roll back (members re-granted, service_role revoked,
# a function missing, a fifth overload), and an absent `migrate` role.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="${VTID_05125_MIGRATION:-$(ls "$ROOT"/supabase/migrations/*_vtid_05125_memory_functions_revoke_migrate.sql)}"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 2; }

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
WORK="$(mktemp -d)"
DBS=()
cleanup() {
  for d in "${DBS[@]}"; do dropdb --if-exists "$d" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

WF='public.write_fact(uuid,uuid,text,text,text,text,text,uuid,numeric,uuid)'
GCF='public.get_current_facts(uuid,uuid,text,text[])'
RAT='public.recall_at_time_range(uuid,timestamptz,timestamptz,text)'
MFS='public.memory_facts_semantic_search(public.vector,integer,uuid,uuid,text,numeric)'
FNS=("$WF" "$GCF" "$RAT" "$MFS")

# Roles as on the live project: migrate is login + replication, and postgres is
# a member of migrate (not the reverse).
"${PSQL[@]}" -d postgres <<'SQL'
DO $$
BEGIN
  IF to_regrole('anon') IS NULL THEN CREATE ROLE anon NOLOGIN; END IF;
  IF to_regrole('authenticated') IS NULL THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF to_regrole('service_role') IS NULL THEN CREATE ROLE service_role NOLOGIN; END IF;
  IF to_regrole('migrate') IS NULL THEN CREATE ROLE migrate LOGIN REPLICATION; END IF;
END $$;
GRANT migrate TO postgres;
SQL

# Stub SECURITY DEFINER functions with the four live signatures and the live
# ACL {postgres=X, service_role=X, migrate=X}. `vector` is a stub domain (no
# pgvector in the container); only the signature matters here.
fixture() {
  "${PSQL[@]}" -d "$1" <<'SQL'
CREATE DOMAIN public.vector AS real[];
CREATE FUNCTION public.write_fact(uuid, uuid, text, text, text, text, text, uuid, numeric, uuid)
  RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS 'SELECT $1';
CREATE FUNCTION public.get_current_facts(uuid, uuid, text, text[])
  RETURNS SETOF text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS 'SELECT $3';
CREATE FUNCTION public.recall_at_time_range(uuid, timestamptz, timestamptz, text)
  RETURNS SETOF text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS 'SELECT $4';
CREATE FUNCTION public.memory_facts_semantic_search(public.vector, integer, uuid, uuid, text, numeric)
  RETURNS SETOF text LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS 'SELECT $5';
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    WHERE p.proname IN ('write_fact', 'get_current_facts', 'recall_at_time_range', 'memory_facts_semantic_search')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.fn);
    IF to_regrole('migrate') IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO migrate', r.fn);
    END IF;
  END LOOP;
END $$;
SQL
}

# Sets $db (not echoed: a command substitution would lose the DBS entry).
newdb() {
  db="migrate_revoke_${1}_$$"
  createdb "$db"
  DBS+=("$db")
  fixture "$db"
}

# has_function_privilege(<role>, <fn>, 'EXECUTE') for every function must be $3.
expect_priv() {
  local db="$1" role="$2" want="$3" fn got
  for fn in "${FNS[@]}"; do
    got="$("${PSQL[@]}" -d "$db" -tA -c "SELECT has_function_privilege('$role', '$fn'::regprocedure, 'EXECUTE')")"
    [ "$got" = "$want" ] || { echo "FAIL [$db] $role EXECUTE on $fn: got $got, want $want" >&2; exit 1; }
  done
}

apply_ok() {
  "${PSQL[@]}" -d "$1" -f "$MIGRATION" >"$WORK/$1.log" 2>&1 || { cat "$WORK/$1.log" >&2; echo "FAIL [$1] migration should have applied" >&2; exit 1; }
}

# The migration must fail with $2 in its error, and change nothing.
apply_refused() {
  if "${PSQL[@]}" -d "$1" -f "$MIGRATION" >"$WORK/$1.log" 2>&1; then
    echo "FAIL [$1] migration applied but should have been refused" >&2; exit 1
  fi
  grep -q "$2" "$WORK/$1.log" || { cat "$WORK/$1.log" >&2; echo "FAIL [$1] expected error: $2" >&2; exit 1; }
}

# 1) Happy path: migrate loses EXECUTE, service_role keeps it, members stay out.
newdb happy
expect_priv "$db" migrate t
apply_ok "$db"
expect_priv "$db" migrate f
expect_priv "$db" service_role t
expect_priv "$db" authenticated f
expect_priv "$db" anon f
acl="$("${PSQL[@]}" -d "$db" -tA -c "SELECT string_agg(DISTINCT proacl::text, ' ') FROM pg_proc WHERE proname IN ('write_fact','get_current_facts','recall_at_time_range','memory_facts_semantic_search')")"
[ "$acl" = "{postgres=X/postgres,service_role=X/postgres}" ] || { echo "FAIL other ACL entries changed: $acl" >&2; exit 1; }
echo 'ok 1 happy path: migrate revoked, service_role kept, members out, other ACL entries untouched'

# 2) Idempotent: a second apply is a no-op.
apply_ok "$db"
expect_priv "$db" migrate f
expect_priv "$db" service_role t
echo 'ok 2 idempotent re-apply'

# 3) Members re-granted (VTID-05041 regressed) → refused, rolled back.
newdb members
"${PSQL[@]}" -d "$db" -c "GRANT EXECUTE ON FUNCTION $WF TO authenticated"
apply_refused "$db" 'executable by members'
expect_priv "$db" migrate t
echo 'ok 3 refused while authenticated holds EXECUTE (rolled back)'

# 4) service_role lost EXECUTE → refused, rolled back.
newdb service
"${PSQL[@]}" -d "$db" -c "REVOKE EXECUTE ON FUNCTION $GCF FROM service_role"
apply_refused "$db" 'service_role (gateway) must keep EXECUTE'
expect_priv "$db" migrate t
echo 'ok 4 refused while service_role lacks EXECUTE (rolled back)'

# 5) One of the four functions missing → refused.
newdb missing
"${PSQL[@]}" -d "$db" -c "DROP FUNCTION $RAT"
apply_refused "$db" 'expected all four memory functions to exist'
FNS_SAVED=("${FNS[@]}"); FNS=("$WF" "$GCF" "$MFS")
expect_priv "$db" migrate t
FNS=("${FNS_SAVED[@]}")
echo 'ok 5 refused while a function is missing (rolled back)'

# 6) A fifth overload → refused, so it is reviewed rather than revoked silently.
newdb overload
"${PSQL[@]}" -d "$db" -c "CREATE FUNCTION public.write_fact(uuid, text) RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS 'SELECT \$1'; REVOKE ALL ON FUNCTION public.write_fact(uuid, text) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.write_fact(uuid, text) TO service_role, migrate;"
apply_refused "$db" 'expected exactly 4 overloads, found 5'
expect_priv "$db" migrate t
echo 'ok 6 refused with a fifth overload (rolled back)'

# 7) No `migrate` role (fresh database, Aurora) → NOTICE, applies.
for d in "${DBS[@]}"; do dropdb --if-exists "$d"; done
DBS=()
"${PSQL[@]}" -d postgres -c 'DROP ROLE migrate'
newdb absent
apply_ok "$db"
grep -q 'VTID-05125: role migrate absent, nothing to revoke' "$WORK/$db.log" || { cat "$WORK/$db.log" >&2; echo 'FAIL missing NOTICE' >&2; exit 1; }
expect_priv "$db" service_role t
expect_priv "$db" authenticated f
echo 'ok 7 absent migrate role: NOTICE, applied'

echo 'PASS vtid-05125 memory functions migrate revoke'
