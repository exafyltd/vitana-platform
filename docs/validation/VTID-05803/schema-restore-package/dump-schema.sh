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

# Record checksum (replace any previous line for this file).
( cd "$PKG" && HASH_LINE="$(sha256sum "$OUT_REL")" && \
  { [ -f SHA256SUMS ] && grep -vF "  $OUT_REL" SHA256SUMS || true; } > SHA256SUMS.new && \
  echo "$HASH_LINE" >> SHA256SUMS.new && mv SHA256SUMS.new SHA256SUMS && echo "sha256: $HASH_LINE" )

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
