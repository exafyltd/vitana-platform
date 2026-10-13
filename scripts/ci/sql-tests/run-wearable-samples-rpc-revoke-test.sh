#!/usr/bin/env bash
# VTID-05156: runs the "health_ingest_wearable_samples(jsonb) is service_role
# only" migration against a throwaway Postgres. Needs PG* env vars (or a local
# socket) pointing at a disposable server whose roles this script may create
# (anon, authenticated, service_role when missing). Refuses to run against
# anything that looks like Supabase or Aurora. Each case gets its own database;
# roles are cluster-wide.
#
# Cases: live shape (authenticated granted, PUBLIC revoked) → members out,
# service_role in, other ACL entries untouched; idempotent re-apply; a PUBLIC
# grant is removed too; the sibling health_ingest_lab_report keeps its grant
# (out of scope); a missing function fails loudly.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MIGRATION="${VTID_05156_MIGRATION:-$(ls "$ROOT"/supabase/migrations/*_vtid_05156_revoke_wearable_samples_rpc.sql)}"
[ -f "$MIGRATION" ] || { echo "migration not found: $MIGRATION" >&2; exit 2; }

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
WORK="$(mktemp -d)"
DBS=()
cleanup() {
  for d in "${DBS[@]}"; do dropdb --if-exists "$d" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

FN='public.health_ingest_wearable_samples(jsonb)'
LAB='public.health_ingest_lab_report(jsonb)'

"${PSQL[@]}" -d postgres <<'SQL'
DO $$
BEGIN
  IF to_regrole('anon') IS NULL THEN CREATE ROLE anon NOLOGIN; END IF;
  IF to_regrole('authenticated') IS NULL THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF to_regrole('service_role') IS NULL THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
SQL

# Stub SECURITY DEFINER functions with the live signatures and the live ACL:
# PUBLIC revoked (Supabase default privileges), authenticated + service_role
# granted (live 2026-10-13: authenticated = true, anon = false). Only the
# signature and the ACL matter here.
fixture() {
  "${PSQL[@]}" -d "$1" <<'SQL'
CREATE FUNCTION public.health_ingest_wearable_samples(p_payload jsonb)
  RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS 'SELECT $1';
CREATE FUNCTION public.health_ingest_lab_report(p_payload jsonb)
  RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS 'SELECT $1';
REVOKE ALL ON FUNCTION public.health_ingest_wearable_samples(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.health_ingest_lab_report(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.health_ingest_wearable_samples(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.health_ingest_lab_report(jsonb) TO authenticated, service_role;
SQL
}

# Sets $db (not echoed: a command substitution would lose the DBS entry).
newdb() {
  db="wearable_revoke_${1}_$$"
  createdb "$db"
  DBS+=("$db")
  fixture "$db"
}

# has_function_privilege(<role>, <fn>, 'EXECUTE') must be $4.
expect_priv() {
  local db="$1" role="$2" fn="$3" want="$4" got
  got="$("${PSQL[@]}" -d "$db" -tA -c "SELECT has_function_privilege('$role', '$fn'::regprocedure, 'EXECUTE')")"
  [ "$got" = "$want" ] || { echo "FAIL [$db] $role EXECUTE on $fn: got $got, want $want" >&2; exit 1; }
}

apply_ok() {
  "${PSQL[@]}" -d "$1" -f "$MIGRATION" >"$WORK/$1.log" 2>&1 || { cat "$WORK/$1.log" >&2; echo "FAIL [$1] migration should have applied" >&2; exit 1; }
}

apply_refused() {
  if "${PSQL[@]}" -d "$1" -f "$MIGRATION" >"$WORK/$1.log" 2>&1; then
    echo "FAIL [$1] migration applied but should have been refused" >&2; exit 1
  fi
  grep -q "$2" "$WORK/$1.log" || { cat "$WORK/$1.log" >&2; echo "FAIL [$1] expected error: $2" >&2; exit 1; }
}

# 1) Live shape: members lose EXECUTE, service_role keeps it, ACL is exactly
#    {owner, service_role}.
newdb happy
expect_priv "$db" authenticated "$FN" t
apply_ok "$db"
expect_priv "$db" authenticated "$FN" f
expect_priv "$db" anon "$FN" f
expect_priv "$db" service_role "$FN" t
acl="$("${PSQL[@]}" -d "$db" -tA -c "SELECT proacl::text FROM pg_proc WHERE oid = '$FN'::regprocedure")"
owner="$("${PSQL[@]}" -d "$db" -tA -c "SELECT current_user")"
[ "$acl" = "{${owner}=X/${owner},service_role=X/${owner}}" ] || { echo "FAIL unexpected ACL: $acl" >&2; exit 1; }
echo 'ok 1 live shape: authenticated + anon out, service_role kept, ACL exact'

# 2) Idempotent: a second apply is a no-op.
apply_ok "$db"
expect_priv "$db" authenticated "$FN" f
expect_priv "$db" service_role "$FN" t
echo 'ok 2 idempotent re-apply'

# 3) The sibling lab-report RPC is out of scope and keeps its grant.
expect_priv "$db" authenticated "$LAB" t
echo 'ok 3 health_ingest_lab_report untouched (out of scope)'

# 4) A PUBLIC grant (Postgres default ACL) is removed too.
newdb public
"${PSQL[@]}" -d "$db" -c "GRANT EXECUTE ON FUNCTION $FN TO PUBLIC"
expect_priv "$db" anon "$FN" t
apply_ok "$db"
expect_priv "$db" anon "$FN" f
expect_priv "$db" authenticated "$FN" f
expect_priv "$db" service_role "$FN" t
echo 'ok 4 PUBLIC grant removed'

# 5) service_role without EXECUTE beforehand gets it.
newdb service
"${PSQL[@]}" -d "$db" -c "REVOKE EXECUTE ON FUNCTION $FN FROM service_role"
apply_ok "$db"
expect_priv "$db" service_role "$FN" t
echo 'ok 5 service_role granted when missing'

# 6) Function missing → fails loudly, nothing applied.
newdb missing
"${PSQL[@]}" -d "$db" -c "DROP FUNCTION $FN"
apply_refused "$db" 'does not exist'
expect_priv "$db" authenticated "$LAB" t
echo 'ok 6 missing function fails loudly'

echo 'PASS vtid-05156 wearable samples rpc revoke'
