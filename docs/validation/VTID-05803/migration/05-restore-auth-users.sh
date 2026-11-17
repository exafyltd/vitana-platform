#!/usr/bin/env bash
# VTID-05803 Option A / B2 — auth.users restore, one phase per call. Called by 03 in this order:
#   pre       -> table DDL (pre-data), then primary key, unique indexes and row-level-security flag
#   data      -> decrypt in the pipe and COPY the rows; triggers do not exist yet, so nothing is provisioned twice
#   post      -> triggers on auth.users, after the data
# Public foreign keys into auth.users are restored AFTER 'pre' (the primary key must exist), by 03.
# Args: <phase> <export-dir>. Env: P (psql connection args), AUTH_KEY_FILE (mode 600).
set -euo pipefail
PHASE=${1:?phase}; EXPORT_DIR=${2:?export-dir}
: "${P:?}" "${AUTH_KEY_FILE:?}"
DUMP="$EXPORT_DIR/auth/auth-users-schema.dump"
[ "$(stat -c %a "$AUTH_KEY_FILE")" = "600" ] || { echo "refused: AUTH_KEY_FILE must be mode 600" >&2; exit 7; }
# scope is checked before ANY phase, so nothing is loaded from an export that is not the approved scope
[ -f "$EXPORT_DIR/auth/MANIFEST.txt" ] || { echo "refused: no auth MANIFEST" >&2; exit 9; }
grep -qx 'auth_scope=without-hashes' "$EXPORT_DIR/auth/MANIFEST.txt" || { echo "refused: auth scope is not without-hashes" >&2; exit 9; }
case "$PHASE" in
  pre)
    pg_restore $P --no-owner --exit-on-error --section=pre-data "$DUMP"
    pg_restore -l "$DUMP" | grep -E ' (CONSTRAINT|INDEX|ROW SECURITY) ' > "$EXPORT_DIR/auth/keys.list" || true
    pg_restore $P --no-owner --exit-on-error -L "$EXPORT_DIR/auth/keys.list" "$DUMP"
    ;;
  data)
    COLS=$(psql $P -X -At -c "SELECT string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='auth' AND table_name='users'")
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass file:"$AUTH_KEY_FILE" -in "$EXPORT_DIR/auth/auth-users-data.enc" \
      | psql $P -X -v ON_ERROR_STOP=1 -c "\\copy auth.users ($COLS) FROM STDIN"
    # fail closed: a without-hashes export must land with no hash on the destination
    HASHES=$(psql $P -X -At -c "SELECT count(encrypted_password) FROM auth.users")
    if [ "$HASHES" != "0" ]; then echo "REFUSED: without-hashes scope but $HASHES hashes restored" >&2; exit 8; fi
    ;;
  post)
    pg_restore -l "$DUMP" | grep ' TRIGGER ' > "$EXPORT_DIR/auth/triggers.list" || true
    pg_restore $P --no-owner --exit-on-error -L "$EXPORT_DIR/auth/triggers.list" "$DUMP"
    ;;
  *) echo "unknown phase $PHASE" >&2; exit 2;;
esac
echo "auth phase $PHASE done"
