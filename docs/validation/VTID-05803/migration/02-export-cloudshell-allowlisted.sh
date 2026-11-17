#!/usr/bin/env bash
# VTID-05803 — native production export, v2.
# Run in the ALLOW-LISTED CloudShell, AFTER the owner-approved one-time exception (01) is active.
# Changes from v1 (review 2026-11-17):
#   - the write-refusal check is READ-ONLY (privilege catalogue queries). v1 ran a CREATE TABLE probe, which
#     would have created a table in production had the role been allowed to create one;
#   - cleanup is an EXIT trap, so the temporary role is revoked and dropped even if the dump fails.
#     v1 unset the password before its cleanup step, so cleanup could not authenticate and the role was left behind;
#   - the dump's table of contents is checked for extension statements before the checksum is written.
# The production URL is read into memory only and never printed or stored. The temporary role's password is
# generated here, used for pg_dump, and destroyed. No secret is created.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export AWS_DEFAULT_REGION=eu-central-1
# Secret NAME (verified read-only 2026-11-17: describe-secret finds it). The random suffix belongs to the ARN, not the name,
# so the ARN-suffix form is not a valid --secret-id. The owner exception covers the ARN pattern database-url-*.
PROD_SECRET_ID="vitana/supabase/prod/database-url"
TS=$(date -u +%Y%m%dT%H%M%SZ); OUT="$HOME/vitana-migration-$TS"; mkdir -p "$OUT/dump"
ROLE=vitana_migration_export
ROLE_CREATED=0
PROD_URL=$(aws secretsmanager get-secret-value --secret-id "$PROD_SECRET_ID" --query SecretString --output text)
eval "$(python3 - "$PROD_URL" <<'PY'
import sys, urllib.parse as u, shlex
p = u.urlparse(sys.argv[1])
print("OWN_HOST=%s OWN_PORT=%s OWN_USER=%s OWN_PASS=%s OWN_DB=%s" % (
  shlex.quote(p.hostname or ""), p.port or 5432, shlex.quote(u.unquote(p.username or "")),
  shlex.quote(u.unquote(p.password or "")), shlex.quote((p.path or "/postgres").lstrip("/") or "postgres")))
PY
)"; unset PROD_URL
export PGSSLMODE=require

# Cleanup runs on every exit path (success, failure, interrupt). It uses the owner account, so OWN_PASS must still be set.
cleanup() {
  local rc=$?
  if [ "$ROLE_CREATED" = 1 ]; then
    export PGPASSWORD="$OWN_PASS"
    psql -X -q -h "$OWN_HOST" -p "$OWN_PORT" -U "$OWN_USER" -d "$OWN_DB" >/dev/null 2>&1 <<SQLCLEAN || true
DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$ROLE') THEN
  EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM $ROLE';
  EXECUTE 'REVOKE ALL ON SCHEMA public FROM $ROLE';
  EXECUTE 'REVOKE pg_read_all_data FROM $ROLE';
  EXECUTE 'REVOKE CONNECT ON DATABASE $OWN_DB FROM $ROLE';
  EXECUTE 'DROP ROLE $ROLE';
END IF; END \$\$;
SQLCLEAN
    if [ "$(psql -X -At -h "$OWN_HOST" -p "$OWN_PORT" -U "$OWN_USER" -d "$OWN_DB" -c "SELECT count(*) FROM pg_roles WHERE rolname='$ROLE'" 2>/dev/null)" = "0" ]; then
      echo "role_removed=true" | tee -a "$OUT/dump-status.txt"
    else
      echo "CLEANUP FAILED: role $ROLE still exists. Drop it manually before anything else." | tee -a "$OUT/dump-status.txt" >&2
      rc=4
    fi
  fi
  unset PW PGPASSWORD OWN_PASS
  exit $rc
}
trap cleanup EXIT

PW=$(openssl rand -hex 24)
EXPIRES=$(date -u -d '+24 hours' '+%Y-%m-%d %H:%M:%S+00')   # literal expiry: CREATE ROLE VALID UNTIL does not accept an expression
SQLF=$(mktemp); chmod 600 "$SQLF"
cat > "$SQLF" <<SQL
DO \$\$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$ROLE') THEN EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM $ROLE'; EXECUTE 'DROP ROLE $ROLE'; END IF; END \$\$;
CREATE ROLE $ROLE LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS PASSWORD '$PW' VALID UNTIL '$EXPIRES';
GRANT CONNECT ON DATABASE $OWN_DB TO $ROLE;
GRANT pg_read_all_data TO $ROLE;
SQL
ROLE_CREATED=1
PGPASSWORD="$OWN_PASS" psql -X -v ON_ERROR_STOP=1 -h "$OWN_HOST" -p "$OWN_PORT" -U "$OWN_USER" -d "$OWN_DB" -f "$SQLF" >/dev/null
rm -f "$SQLF"
# OWN_PASS stays set on purpose: the EXIT trap needs it to revoke and drop the temporary role. It is unset in cleanup().
export PGPASSWORD="$PW"

# VERIFY (read-only): role attributes, and no privilege other than SELECT on any object the role can reach.
psql -X -At -h "$OWN_HOST" -p "$OWN_PORT" -U "$ROLE" -d "$OWN_DB" \
  -c "SELECT 'attrs', rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname='$ROLE'" | tee "$OUT/role-check.txt"
NON_SELECT=$(psql -X -At -h "$OWN_HOST" -p "$OWN_PORT" -U "$ROLE" -d "$OWN_DB" -c "
  SELECT count(*) FROM information_schema.role_table_grants
  WHERE grantee = '$ROLE' AND privilege_type <> 'SELECT'")
SCHEMA_CREATE=$(psql -X -At -h "$OWN_HOST" -p "$OWN_PORT" -U "$ROLE" -d "$OWN_DB" -c "
  SELECT count(*) FROM pg_namespace n WHERE has_schema_privilege('$ROLE', n.oid, 'CREATE') AND n.nspname NOT LIKE 'pg\_%' AND n.nspname <> 'information_schema'")
echo "non_select_table_privileges=$NON_SELECT schemas_with_create=$SCHEMA_CREATE" | tee -a "$OUT/role-check.txt"
if [ "$NON_SELECT" != "0" ] || [ "$SCHEMA_CREATE" != "0" ]; then
  echo "FAIL: role $ROLE has write or create privileges; refusing to dump" >&2; exit 3
fi

# DUMP: native PostgreSQL, directory format, parallel, one consistent snapshot.
pg_dump -Fd -j 4 --serializable-deferrable --no-owner --no-tablespaces \
  -n public -n governance -n legacy_archive \
  -T public.awsdms_ddl_audit -T public.awsdms_heartbeat \
  -h "$OWN_HOST" -p "$OWN_PORT" -U "$ROLE" -d "$OWN_DB" -f "$OUT/dump"
echo "dump complete" | tee "$OUT/dump-status.txt"
# SOURCE METRICS (read-only, counts and md5 digests only): the target must match these exactly (restore-core.sh step 9)
psql -X -q -At -v ON_ERROR_STOP=1 -h "$OWN_HOST" -p "$OWN_PORT" -U "$ROLE" -d "$OWN_DB" -f "$HERE/counts.sql" > "$OUT/source-counts.txt"
echo "source_metrics=$(wc -l < "$OUT/source-counts.txt")" >> "$OUT/dump-status.txt"
# AUTH.USERS (Option A / B2): runs ONLY when the owner has approved the scope and set AUTH_SCOPE and AUTH_KEY_FILE.
# Still under the temporary role (its cleanup is the EXIT trap below).
if [ -n "${AUTH_SCOPE:-}" ]; then
  export AUTH_SCOPE AUTH_KEY_FILE OUT OWN_HOST OWN_PORT ROLE OWN_DB
  bash "$HERE/04-export-auth-users.sh"
  echo "auth export: $AUTH_SCOPE" >> "$OUT/dump-status.txt"
fi

# TOC CHECK (local, no DB access): no extension statements may be in the dump; the Aurora script installs its own.
pg_restore -l "$OUT/dump" > "$OUT/toc.txt"
if grep -q " EXTENSION " "$OUT/toc.txt"; then echo "FAIL: dump contains EXTENSION entries" >&2; exit 5; fi
echo "toc_entries=$(wc -l < "$OUT/toc.txt")" | tee -a "$OUT/dump-status.txt"

# MANIFEST: checksums (verified immediately after writing)
( cd "$OUT" && { find dump -type f; [ -d auth ] && find auth -type f; [ -f source-counts.txt ] && echo source-counts.txt; } | sort | xargs sha256sum > SHA256SUMS && sha256sum -c SHA256SUMS >/dev/null )
echo "export directory: $OUT"; wc -l "$OUT/SHA256SUMS"
# cleanup of the role runs from the EXIT trap
