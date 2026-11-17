#!/usr/bin/env bash
# VTID-05803 — shared restore sequence. Run by 03 (Aurora staging, master credentials fetched there) and by the
# synthetic rehearsal (local PostgreSQL). The same code runs in both places; only the connection differs.
# Arg 1: export directory. Env: P (connection args, NO password), PGPASSWORD (if required), AUTH_KEY_FILE (if an auth export exists).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXPORT_DIR=${1:?usage: $0 <export-dir>}
: "${P:?connection args P required}"
refuse() { echo "REFUSED: $*" >&2; exit "${CODE:-1}"; }

# 1. integrity of every exported file (dump, auth files and manifests)
( cd "$EXPORT_DIR" && sha256sum -c SHA256SUMS >/dev/null ) || { CODE=1 refuse "checksum mismatch"; }
echo "checksums: OK"

# 2. Supabase roles and production auth helpers (before any GRANT or POLICY in the dump)
psql $P -X -v ON_ERROR_STOP=1 -f "$HERE/00-supabase-roles-and-auth.sql" >/dev/null

# 3. restore list: the target already has the public schema, so its CREATE and COMMENT entries are dropped
pg_restore -l "$EXPORT_DIR/dump" | grep -v -E ' SCHEMA - public | COMMENT - SCHEMA public ' > "$EXPORT_DIR/restore.list"

# 4. auth scope guard: only the owner-approved scope (without password hashes) is accepted
HAS_AUTH=0
if [ -d "$EXPORT_DIR/auth" ]; then
  HAS_AUTH=1
  [ -f "$EXPORT_DIR/auth/MANIFEST.txt" ] || { CODE=9 refuse "auth export without MANIFEST"; }
  grep -qx 'auth_scope=without-hashes' "$EXPORT_DIR/auth/MANIFEST.txt" || { CODE=9 refuse "auth scope is not the approved without-hashes scope"; }
  : "${AUTH_KEY_FILE:?AUTH_KEY_FILE required for the auth export}"
fi
export AUTH_KEY_FILE P

# 5. ordered restore. Public foreign keys into auth.users need the auth primary key and rows, so they come after both.
#    public pre -> auth pre -> public data -> auth data -> public post (foreign keys, policies) -> auth post (triggers)
pg_restore $P --no-owner --exit-on-error -L "$EXPORT_DIR/restore.list" --section=pre-data "$EXPORT_DIR/dump"
if [ "$HAS_AUTH" = 1 ]; then bash "$HERE/05-restore-auth-users.sh" pre "$EXPORT_DIR"; fi
pg_restore $P --no-owner --exit-on-error -L "$EXPORT_DIR/restore.list" --section=data -j 4 "$EXPORT_DIR/dump"
if [ "$HAS_AUTH" = 1 ]; then bash "$HERE/05-restore-auth-users.sh" data "$EXPORT_DIR"; fi
pg_restore $P --no-owner --exit-on-error -L "$EXPORT_DIR/restore.list" --section=post-data "$EXPORT_DIR/dump"
if [ "$HAS_AUTH" = 1 ]; then bash "$HERE/05-restore-auth-users.sh" post "$EXPORT_DIR"; fi
echo "ordered restore: complete"

# 6. staging outbox: the outbox table, then the corrected functions that post to the reserved .invalid host
psql $P -X -v ON_ERROR_STOP=1 -f "$HERE/aurora-cutover-outbox.sql" >/dev/null
psql $P -X -v ON_ERROR_STOP=1 -f "$HERE/02-outbox-replacement-corrected.sql" >/dev/null
echo "outbox: applied"

# 7. production-host exclusion, after the outbox replacement. Any non-zero count refuses the restore.
HOST_REPORT="$EXPORT_DIR/host-exclusion.txt"
psql $P -X -q -At -f "$HERE/06-production-host-exclusion-check.sql" > "$HOST_REPORT"
# strict parse: every line must be name|integer (psql status lines are not data); any other line refuses
if ! awk -F'|' 'NF==2 && $1 ~ /^[a-z_]+$/ && $2 ~ /^[0-9]+$/ {n++; if ($2 != 0) bad=1; next} {junk=1} END {exit (bad || junk || n < 7)}' "$HOST_REPORT"; then
  CODE=6 refuse "production host referenced, or host report malformed (see host-exclusion.txt)"
fi
echo "production_host_exclusion: clean"

# 8. nothing may be queued during a restore: the outbox must be empty
if [ "$(psql $P -X -At -c "SELECT to_regclass('public.outbound_http_requests') IS NOT NULL")" = "t" ]; then
  QUEUED=$(psql $P -X -At -c "SELECT count(*) FROM public.outbound_http_requests")
  [ "$QUEUED" = "0" ] || { CODE=10 refuse "$QUEUED outbox rows queued during restore"; }
fi
echo "outbox_rows_queued=0"

# 9. preservation: all 23 aggregate metrics must be present on BOTH sides, and every per-function definition must match
#    except the two notify_* definitions, which the staging outbox replaces by design. Each of those two must differ
#    (a non-differing one means the replacement did not apply and the restore refuses).
REQ="tables partitions views matviews sequences indexes enums functions function_names_md5 triggers policies rls_enabled_tables fk_constraints fk_to_auth_users acl_entries md5_acl auth_users_triggers auth_users_rls auth_users_rows auth_users_pk md5_triggers md5_policies md5_foreign_keys"
psql $P -X -q -At -v ON_ERROR_STOP=1 -f "$HERE/counts.sql" > "$EXPORT_DIR/target-counts.txt" || { CODE=14 refuse "target metrics failed to run"; }
[ -f "$EXPORT_DIR/source-counts.txt" ] || { CODE=12 refuse "source-counts.txt missing from the export"; }
for m in $REQ; do
  grep -q "^$m|" "$EXPORT_DIR/source-counts.txt" || { CODE=14 refuse "source missing metric $m"; }
  grep -q "^$m|" "$EXPORT_DIR/target-counts.txt" || { CODE=14 refuse "target missing metric $m"; }
done
echo "required aggregate metrics present on both sides: $(echo $REQ | wc -w)"
sort "$EXPORT_DIR/source-counts.txt" > "$EXPORT_DIR/source-counts.sorted"; sort "$EXPORT_DIR/target-counts.txt" > "$EXPORT_DIR/target-counts.sorted"
diff "$EXPORT_DIR/source-counts.sorted" "$EXPORT_DIR/target-counts.sorted" > "$EXPORT_DIR/counts.diff" || true
UNEXPECTED=$(grep -E '^[<>] ' "$EXPORT_DIR/counts.diff" | cut -c3- | cut -d'|' -f1 | sort -u | grep -v -x -E 'fn_def:notify_test_user_confirmation\(\)|fn_def:notify_welcome_discount\(\)' || true)
[ -z "$UNEXPECTED" ] || { CODE=11 refuse "unexpected preservation differences: $(echo $UNEXPECTED)"; }
for f in 'fn_def:notify_test_user_confirmation()' 'fn_def:notify_welcome_discount()'; do
  grep -F -q "$f|" "$EXPORT_DIR/counts.diff" || { CODE=11 refuse "$f did not change: the staging outbox replacement is not applied"; }
done
DIFFS=$(grep -c -E '^[<>] ' "$EXPORT_DIR/counts.diff" || true)
echo "preservation: 23 aggregate metrics identical; every function identical except the 2 staging outbox replacements (diff lines: $DIFFS)"

# 10. cron: no pg_cron extension, so no job can exist on staging
CRON_EXT=$(psql $P -X -At -c "SELECT count(*) FROM pg_extension WHERE extname='pg_cron'")
echo "cron_extension_installed=$CRON_EXT (expected 0)"
[ "$CRON_EXT" = "0" ] || { CODE=13 refuse "pg_cron present on staging"; }
echo "restore-core: PASS"
