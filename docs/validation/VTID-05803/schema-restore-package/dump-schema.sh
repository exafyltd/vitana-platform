#!/usr/bin/env bash
# VTID-05803 step 0: native schema-only dump of the source `public` schema -> sql/base-schema-public.sql
# Usage: SOURCE_URI=postgresql://... ./dump-schema.sh [PACKAGE_DIR]   (PACKAGE_DIR defaults to .)
# The native dump is authoritative: it carries tables, constraints (all FKs, VALID), indexes, functions, triggers, RLS
# policies AND privileges (GRANT/REVOKE). Only owners are dropped (--no-owner): source owners do not exist on Aurora.
# Never prints SOURCE_URI. Refuses: non-17 pg_dump, the transaction pooler (6543), empty or truncated output, any data
# section (TABLE DATA / SEQUENCE SET / COPY / setval), and replication or foreign-server objects.
# One deterministic rewrite, counted in the output: `CREATE SCHEMA public;` -> `CREATE SCHEMA IF NOT EXISTS public;`
# (the schema always exists on the target; pg_dump -n public emits the bare form).
set -euo pipefail
umask 077

PKG="${1:-.}"
OUT_REL="sql/base-schema-public.sql"
OUT="$PKG/$OUT_REL"

die() { echo "REFUSED: $*" >&2; exit 1; }
redact() { R_URI="$SOURCE_URI" awk '{ u=ENVIRON["R_URI"]; while ((i = index($0, u)) > 0) $0 = substr($0, 1, i-1) "<SOURCE_URI>" substr($0, i+length(u)); print }'; }

[ -n "${SOURCE_URI:-}" ] || die "SOURCE_URI is not set"
[ -d "$PKG/sql" ] || die "package dir '$PKG' has no sql/ directory"
command -v pg_dump >/dev/null || die "pg_dump not on PATH (need PostgreSQL 17 client)"
case "$SOURCE_URI" in *:6543/*|*:6543\?*|*:6543) die "port 6543 is the transaction pooler; pg_dump needs session mode (5432)";; esac

# Gate 1: client major version 17.
VER_LINE="$(pg_dump --version)"
MAJOR="$(printf '%s\n' "$VER_LINE" | sed -nE 's/^pg_dump \(PostgreSQL\) ([0-9]+)(\.[0-9]+)?.*/\1/p')"
[ "$MAJOR" = "17" ] || die "pg_dump major version is '${MAJOR:-unparsed}', need 17 ($VER_LINE)"
echo "gate 1 ok: $VER_LINE"

# Gate 2: dump into a temp file; stderr is redacted so the URI cannot leak via error text.
TMP="$(mktemp "$PKG/sql/.base-schema.XXXXXX")"
ERR="$(mktemp)"
trap 'rm -f "$TMP" "$ERR"' EXIT
if ! pg_dump --schema-only --no-owner --schema=public --no-publications --no-subscriptions \
      --no-security-labels --lock-wait-timeout=30s --dbname="$SOURCE_URI" >"$TMP" 2>"$ERR"; then
  redact <"$ERR" >&2
  die "pg_dump failed"
fi
[ -s "$ERR" ] && redact <"$ERR" >&2

# Gate 3: non-empty, real DDL, complete (trailer present, nothing executable after it).
[ -s "$TMP" ] || die "dump output is empty"
head -n 5 "$TMP" | grep -qx -- '-- PostgreSQL database dump' || die "no pg_dump header"
grep -qE '^CREATE (TABLE|FUNCTION|OR REPLACE FUNCTION|VIEW|INDEX|UNIQUE INDEX|SEQUENCE|TYPE)' "$TMP" \
  || die "dump output contains no CREATE statements"
T="$(grep -nx -- '-- PostgreSQL database dump complete' "$TMP" | tail -n1 | cut -d: -f1 || true)"
[ -n "$T" ] || die "dump-complete trailer missing (truncated dump)"
awk -v t="$T" 'NR>t && !/^[[:space:]]*$/ && !/^--/ && !/^\\unrestrict / {bad=1} END {exit bad}' "$TMP" \
  || die "statements after the dump-complete trailer"
if grep -q '^\\restrict ' "$TMP"; then
  [ "$(grep -c '^\\restrict ' "$TMP")" = 1 ] && [ "$(grep -c '^\\unrestrict ' "$TMP")" = 1 ] \
    || die "\\restrict/\\unrestrict not paired exactly once"
fi

# Gate 4: no data. Detection by pg_dump's own section markers, not by statement text: INSERT INTO inside a
# plpgsql function body is DDL and must pass.
DATA="$(grep -cE '^-- .*Type: (TABLE DATA|SEQUENCE SET|BLOB|BLOBS|LARGE OBJECT);|^COPY [^ ]+ .*FROM stdin;$|^SELECT pg_catalog\.setval\(' "$TMP" || true)"
[ "$DATA" = "0" ] || die "dump contains $DATA data section(s)"
grep -qiE '^CREATE (SUBSCRIPTION|PUBLICATION|SERVER|USER MAPPING|FOREIGN DATA WRAPPER)' "$TMP" \
  && die "dump creates replication/foreign-server objects"

# Gate 5: the URI itself must not appear in the file.
grep -qF -- "$SOURCE_URI" "$TMP" && die "dump output contains the source connection string"

# The one rewrite.
RW="$(grep -cx 'CREATE SCHEMA public;' "$TMP" || true)"
sed -i 's/^CREATE SCHEMA public;$/CREATE SCHEMA IF NOT EXISTS public;/' "$TMP"
echo "rewrite: CREATE SCHEMA public; -> IF NOT EXISTS ($RW line(s))"

mv "$TMP" "$OUT"
trap 'rm -f "$ERR"' EXIT

# auth.users stub from the source catalog: the source's column names and types, primary key on id only, no rows, no
# defaults, no NOT NULL, no triggers. Views and policies over auth.users then restore unchanged. A column whose type is
# not in pg_catalog becomes text. Read-only query; catalog only, never rows.
STUB_REL="sql/auth-users-stub.sql"
command -v psql >/dev/null || die "psql not on PATH (needed for the auth.users stub)"
if ! psql -X -q -At -v ON_ERROR_STOP=1 -d "$SOURCE_URI" -c "SET default_transaction_read_only = on" -c "SELECT 'CREATE SCHEMA IF NOT EXISTS auth;'" -c "
  SELECT 'CREATE TABLE IF NOT EXISTS auth.users (' || string_agg(format('%I %s%s', a.attname,
           CASE WHEN tn.nspname = 'pg_catalog' THEN format_type(a.atttypid, a.atttypmod) ELSE 'text' END,
           CASE WHEN a.attname = 'id' THEN ' PRIMARY KEY' ELSE '' END), ', ' ORDER BY a.attnum) || ');'
  FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = t.typnamespace
  WHERE a.attrelid = 'auth.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped" >"$PKG/$STUB_REL.tmp" 2>"$ERR"; then
  redact <"$ERR" >&2; rm -f "$PKG/$STUB_REL.tmp"; die "auth.users column read failed"
fi
grep -q '"\?id"\? uuid PRIMARY KEY' "$PKG/$STUB_REL.tmp" || { rm -f "$PKG/$STUB_REL.tmp"; die "source auth.users has no uuid id column"; }
mv "$PKG/$STUB_REL.tmp" "$PKG/$STUB_REL"
echo "auth.users stub: $(grep -o ', ' "$PKG/$STUB_REL" | wc -l | awk '{print $1+1}') columns from the source catalog, 0 rows"

# Extensions in the schema the source has them in (pg_dump -n public does not emit CREATE EXTENSION). Only the
# extensions approved for Aurora staging are written; the others are listed as comments for the record.
EXT_REL="sql/extensions.sql"
APPROVED="vector pg_trgm unaccent fuzzystrmatch uuid-ossp pgcrypto pg_stat_statements"
if ! psql -X -q -At -F '|' -v ON_ERROR_STOP=1 -d "$SOURCE_URI" -c "SET default_transaction_read_only = on" \
     -c "SELECT x.extname, n.nspname FROM pg_extension x JOIN pg_namespace n ON n.oid = x.extnamespace WHERE x.extname <> 'plpgsql' ORDER BY 1" \
     >"$PKG/$EXT_REL.raw" 2>"$ERR"; then redact <"$ERR" >&2; rm -f "$PKG/$EXT_REL.raw"; die "extension read failed"; fi
awk -F'|' -v ok=" $APPROVED " 'index(ok, " " $1 " ") { printf "CREATE SCHEMA IF NOT EXISTS %s;\nCREATE EXTENSION IF NOT EXISTS \"%s\" WITH SCHEMA %s;\n", $2, $1, $2; next }
  { printf "-- not on Aurora staging: %s (schema %s)\n", $1, $2 }' "$PKG/$EXT_REL.raw" > "$PKG/$EXT_REL"; rm -f "$PKG/$EXT_REL.raw"
echo "extensions: $(grep -c '^CREATE EXTENSION' "$PKG/$EXT_REL") approved, $(grep -c '^-- not on' "$PKG/$EXT_REL") not carried"

# Live source counts with the same probe the restore runs on the target (catalog only, read-only).
SRC_REL="sql/source-counts.txt"
psql -X -q -At -v ON_ERROR_STOP=1 -d "$SOURCE_URI" -c "SET default_transaction_read_only = on" -f "$PKG/sql/parity-probe.sql" \
  >"$PKG/$SRC_REL" 2>"$ERR" || { redact <"$ERR" >&2; die "source parity probe failed"; }
grep -q '^tables|[0-9]' "$PKG/$SRC_REL" || die "source parity probe produced no counts"
echo "source counts: $(tr '\n' ' ' < "$PKG/$SRC_REL" | cut -c1-200)"

# Record checksums (replace any previous lines for these files).
for REL in "$OUT_REL" "$STUB_REL" "$EXT_REL" "$SRC_REL"; do
  ( cd "$PKG" && HASH_LINE="$(sha256sum "$REL")" && \
    { [ -f SHA256SUMS ] && grep -vF "  $REL" SHA256SUMS || true; } > SHA256SUMS.new && \
    echo "$HASH_LINE" >> SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS && echo "sha256: $HASH_LINE" )
done

cnt() { grep -cE "$1" "$OUT" || true; }
echo "objects: tables=$(cnt '^CREATE (UNLOGGED )?TABLE ')" \
     "functions=$(cnt '^CREATE (OR REPLACE )?(FUNCTION|PROCEDURE) ')" \
     "indexes=$(cnt '^CREATE (UNIQUE )?INDEX ')" \
     "policies=$(cnt '^CREATE POLICY ')" \
     "views=$(cnt '^CREATE (OR REPLACE )?(MATERIALIZED )?VIEW ')" \
     "triggers=$(cnt '^CREATE (OR REPLACE )?(CONSTRAINT )?TRIGGER ')" \
     "grants=$(cnt '^(GRANT|REVOKE) ')" \
     "fks=$(cnt 'FOREIGN KEY')"
echo "ok: wrote $OUT_REL ($(wc -c <"$OUT") bytes)"
