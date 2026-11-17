#!/usr/bin/env bash
# VTID-05803 Option A / B2 — auth.users export. Called by 02 ONLY when AUTH_SCOPE is set (owner-approved scope).
# Inputs (exported by 02): OUT, OWN_HOST, OWN_PORT, ROLE, OWN_DB, PGPASSWORD (the temporary role).
# AUTH_SCOPE: without-hashes (the only approved scope). encrypted_password is exported as NULL.
# AUTH_KEY_FILE: owner-provided passphrase file, mode 600, outside the repository. Never printed.
# Plaintext rows are never written to disk: the data stream is encrypted in the pipe. Hashes are NULL in the stream.
set -euo pipefail
: "${OUT:?}" "${OWN_HOST:?}" "${OWN_PORT:?}" "${ROLE:?}" "${OWN_DB:?}" "${AUTH_SCOPE:?}" "${AUTH_KEY_FILE:?}"
# Only the owner-approved scope is accepted (approved 2026-11-17: auth.users WITHOUT password hashes).
# Password hashes are not exported by this script under any setting; with-hashes is refused by design.
[ "$AUTH_SCOPE" = without-hashes ] || { echo "refused: AUTH_SCOPE must be exactly without-hashes (approved scope)" >&2; exit 7; }
[ -r "$AUTH_KEY_FILE" ] || { echo "refused: AUTH_KEY_FILE unreadable" >&2; exit 7; }
[ "$(stat -c %a "$AUTH_KEY_FILE")" = "600" ] || { echo "refused: AUTH_KEY_FILE must be mode 600" >&2; exit 7; }
mkdir -p "$OUT/auth"; chmod 700 "$OUT/auth"
CONN=(-h "$OWN_HOST" -p "$OWN_PORT" -U "$ROLE" -d "$OWN_DB")
# 1. DDL only, custom format: table, indexes, constraints and triggers restore in separate sections.
pg_dump -Fc --schema-only --no-owner --no-tablespaces -t auth.users "${CONN[@]}" -f "$OUT/auth/auth-users-schema.dump"
# 2. data: explicit column list in table order. Built in SQL so the hash column is replaced by NULL exactly when
#    AUTH_SCOPE=without-hashes (quote_ident leaves encrypted_password unquoted, so text substitution is not used).
SEL=$(psql -X -At "${CONN[@]}" -c "SELECT string_agg(CASE WHEN column_name='encrypted_password' THEN 'NULL::varchar AS encrypted_password' ELSE quote_ident(column_name) END, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='auth' AND table_name='users'")
COLS=$(psql -X -At "${CONN[@]}" -c "SELECT string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='auth' AND table_name='users'")
psql -X "${CONN[@]}" -c "\\copy (SELECT $SEL FROM auth.users ORDER BY id) TO STDOUT" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt -pass file:"$AUTH_KEY_FILE" -out "$OUT/auth/auth-users-data.enc"
chmod 600 "$OUT/auth/auth-users-data.enc"
ROWS=$(psql -X -At "${CONN[@]}" -c "SELECT count(*) FROM auth.users")
{
  echo "auth_scope=without-hashes"
  echo "auth_users_rows=$ROWS"
  echo "columns=$(printf '%s' "$COLS" | tr ',' '\n' | wc -l)"
  echo "schema_dump_sha256=$(sha256sum "$OUT/auth/auth-users-schema.dump" | cut -d' ' -f1)"
  echo "data_enc_sha256=$(sha256sum "$OUT/auth/auth-users-data.enc" | cut -d' ' -f1)"
} > "$OUT/auth/MANIFEST.txt"
echo "auth export written: $ROWS rows, scope=$AUTH_SCOPE (no row content printed)"
