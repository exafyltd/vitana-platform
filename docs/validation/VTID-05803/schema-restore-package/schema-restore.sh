#!/usr/bin/env bash
# VTID-05803: the ONE staging restore: schema-only restore of the native PG17 `public` dump into the Aurora STAGING writer.
# Order: gates (read-only) -> extensions -> auth stub -> [auth helpers, only if owner-approved] -> precondition check
#        -> psql -v ON_ERROR_STOP=1 --single-transaction -f DUMP_FILE -> object counts.
# Never runs the 0730de73 delta SQL, aurora-cutover-vector-postload.sql or any outbox SQL.
# Env: STAGING_PGURI DUMP_FILE DUMP_SHA256 EXT_SCHEMA(extensions|public)  [AUTH_HELPERS=approved] [EXTENSIONS="..."]
# Exit: 0 ok | 1 refused, nothing written | 2 failed after writes began | 3 loaded but counts do not match the dump.
# STAGING_PGURI is never printed: psql stderr is redacted. (It is visible in /proc/*/cmdline while psql runs.)
set -euo pipefail
umask 077
HERE="$(cd "$(dirname "$0")" && pwd)"
WRITER="vitana-aurora-staging.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com"
STUB="$HERE/sql/aurora-auth-compat-stub.sql"
STUB_SHA="6404df9fd68b64e661be2cf7b743b16ecee46d7d9f5027e53e07450766954a33"      # = 0730de73 SHA256SUMS
HELPERS="$HERE/sql/auth-helpers-production-definitions.sql"
HELPERS_SHA="d600eefcc0cc8abad64b87627a3bccd96d294c01269dd3337420758ef2f7c3b5"   # = 0730de73 SHA256SUMS
APPROVED_EXT="vector pg_trgm unaccent fuzzystrmatch uuid-ossp pgcrypto pg_stat_statements"  # 0730de73 schema-restore.sh:24

die()  { echo "REFUSED: $*" >&2; exit 1; }
fail() { echo "FAILED: $*" >&2; exit 2; }
redact() { R_URI="${STAGING_PGURI:-}" R_PW="${PW:-}" awk '{ u=ENVIRON["R_URI"]; p=ENVIRON["R_PW"]
  if (u != "") while ((i = index($0, u)) > 0) $0 = substr($0, 1, i-1) "<STAGING_PGURI>" substr($0, i+length(u))
  if (length(p) >= 4) while ((i = index($0, p)) > 0) $0 = substr($0, 1, i-1) "<PW>" substr($0, i+length(p))
  print }'; }
pq() { local e rc=0; e="$(mktemp)"; psql -X -d "$STAGING_PGURI" "$@" 2>"$e" || rc=$?; redact <"$e" >&2; rm -f "$e"; return $rc; }
q()  { pq -At -v ON_ERROR_STOP=1 -c "$1"; }

: "${DUMP_FILE:=$HERE/sql/base-schema-public.sql}"
[ -n "${DUMP_SHA256:-}" ] || DUMP_SHA256="$(awk '$2=="sql/base-schema-public.sql"{print $1}' "$HERE/SHA256SUMS" 2>/dev/null || true)"
: "${EXT_SCHEMA:=extensions}"
# ---- Gate 1: inputs ----------------------------------------------------------------------------------------------
for v in STAGING_PGURI DUMP_FILE DUMP_SHA256 EXT_SCHEMA; do [ -n "${!v:-}" ] || die "$v is not set"; done
case "$EXT_SCHEMA" in extensions|public) ;; *) die "EXT_SCHEMA must be 'extensions' or 'public' (owner decision D2)";; esac
[ -f "$DUMP_FILE" ] && [ -s "$DUMP_FILE" ] || die "DUMP_FILE missing or empty"
command -v psql >/dev/null || die "psql not on PATH"
PV="$(psql --version | sed -nE 's/^psql \(PostgreSQL\) ([0-9]+)\.([0-9]+).*/\1 \2/p')"
[ "${PV%% *}" = "17" ] || die "psql major must be 17 (got '${PV:-unparsed}')"
EXTS="${EXTENSIONS:-$APPROVED_EXT}"
for e in $EXTS; do case " $APPROVED_EXT " in *" $e "*) ;; *) die "extension '$e' is not on the approved list";; esac; done
echo "gate 1 ok: inputs, psql ${PV/ /.}"

# ---- Gate 2: target host, from the URI only (no PGHOST/service fallbacks, no host override parameters) ------------
unset PGHOST PGHOSTADDR PGSERVICE PGSERVICEFILE PGDATABASE PGPORT
case "$STAGING_PGURI" in postgresql://*|postgres://*) ;; *) die "STAGING_PGURI must be a postgresql:// URI";; esac
REST="${STAGING_PGURI#*://}"; AUTH="${REST%%[/?]*}"; TAIL="${REST:${#AUTH}}"
PW=""; case "$AUTH" in *@*) UI="${AUTH%@*}"; case "$UI" in *:*) PW="${UI#*:}";; esac;; esac
HP="${AUTH##*@}"; HOST="$(printf '%s' "${HP%%:*}" | tr 'A-Z' 'a-z')"
P="${TAIL%%\?*}"; DB="${P#/}"; QS=""; case "$TAIL" in *\?*) QS="${TAIL#*\?}";; esac
case "$HP" in *,*) die "multi-host URI";; esac
case "&$QS" in *"&host="*|*"&hostaddr="*|*"&service="*|*"&dbname="*) die "URI overrides host/hostaddr/service/dbname";; esac
case "&$QS" in *"&sslmode=disable"*|*"&sslmode=allow"*|*"&sslmode=prefer"*) die "sslmode weaker than require";; esac
case "$HOST" in *prod*|*rehearsal*|*awsdr*|*supabase*|*pooler*) die "non-staging host name";; esac
[ "$HOST" = "$WRITER" ] || die "host is not the staging writer"
[ "$DB" = "vitana" ] || die "database is not 'vitana'"
export PGSSLMODE="${PGSSLMODE:-require}"; [ "$PGSSLMODE" = disable ] && die "PGSSLMODE=disable"
echo "gate 2 ok: staging writer / vitana"

# ---- Gate 3: dump integrity and content (local) --------------------------------------------------------------------
case "$(basename "$DUMP_FILE")" in aurora-*|outbox-*|auth-helpers-*|parity-*|host-exclusion-*|*vector-postload*)
  die "DUMP_FILE is a 0730de73 package/delta file, not the base dump";; esac
GOT="$(sha256sum "$DUMP_FILE" | cut -d' ' -f1)"
[ "$GOT" = "$(printf '%s' "$DUMP_SHA256" | tr 'A-F' 'a-f')" ] || die "dump checksum mismatch (got $GOT)"
[ "$(sha256sum "$STUB" | cut -d' ' -f1)" = "$STUB_SHA" ] || die "auth stub checksum mismatch"
head -n 5 "$DUMP_FILE" | grep -qx -- '-- PostgreSQL database dump' || die "no pg_dump header"
grep -qE '^-- Dumped by pg_dump version 17\.' "$DUMP_FILE" || die "not a native pg_dump 17 dump"
T="$(grep -nx -- '-- PostgreSQL database dump complete' "$DUMP_FILE" | tail -n1 | cut -d: -f1 || true)"
[ -n "$T" ] || die "dump-complete trailer missing (truncated dump?)"
awk -v t="$T" 'NR>t && !/^[[:space:]]*$/ && !/^--/ && !/^\\unrestrict / {bad=1} END {exit bad}' "$DUMP_FILE" \
  || die "statements after the dump-complete trailer"
N="$(grep -cE '^-- .*Type: (TABLE DATA|SEQUENCE SET|BLOB|BLOBS|LARGE OBJECT);|^COPY [^ ]+ .*FROM stdin;$|^SELECT pg_catalog\.setval\(' "$DUMP_FILE" || true)"
[ "$N" = "0" ] || die "dump contains $N data statement(s)/data TOC entries"
grep -qiE 'inmkhvwdcuyhnxkgfvsb|pooler\.supabase|supabase\.co|aurora-prod|rehearsal' "$DUMP_FILE" \
  && die "production/rehearsal reference in dump (production-connected SQL; owner decision D5)"
grep -qiE '^CREATE (SUBSCRIPTION|PUBLICATION|SERVER|USER MAPPING|FOREIGN DATA WRAPPER)' "$DUMP_FILE" \
  && die "dump creates replication/foreign-server objects"
grep -qE '^CREATE SCHEMA public;' "$DUMP_FILE" && die "dump contains 'CREATE SCHEMA public;' (fails on Aurora; owner decision D4)"
if grep -qE '(^|[^a-z_])extensions\.' "$DUMP_FILE" && [ "$EXT_SCHEMA" != extensions ]; then
  die "dump references extensions.* but EXT_SCHEMA=$EXT_SCHEMA"; fi
if grep -q '^\\restrict ' "$DUMP_FILE" && [ "${PV##* }" -lt 6 ]; then die "dump uses \\restrict; needs psql >= 17.6"; fi
EXP_TABLES="$(grep -cE '^CREATE (UNLOGGED )?TABLE public\.' "$DUMP_FILE" || true)"
echo "gate 3 ok: sha256 $GOT, trailer at line $T, 0 data statements, expected tables=$EXP_TABLES"

# ---- Gate 4: live target, read-only ----------------------------------------------------------------------------------
C="$(q "/*gate:conn*/ select current_database()||'|'||pg_is_in_recovery()::text||'|'||current_setting('server_version_num')")" \
  || die "cannot connect / query target"
IFS='|' read -r CDB REC SVN <<<"$C"
[ "$CDB" = vitana ] || die "connected database is '$CDB'"
[ "$REC" = false ] || die "target is in recovery (reader, not writer)"
[ "${SVN:0:2}" = 17 ] && [ "${#SVN}" = 6 ] || die "server_version_num $SVN is not PostgreSQL 17"
PUB="$(q "/*gate:public*/ select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','f','S')")"
[ "$PUB" = "0" ] || die "public schema already holds $PUB relations"
echo "gate 4 ok: writer, PG $SVN, public relations = 0"

# ---- Step 1: extensions ------------------------------------------------------------------------------------------------
[ "$EXT_SCHEMA" = extensions ] && { q "CREATE SCHEMA IF NOT EXISTS extensions" >/dev/null || fail "create schema extensions"; }
for e in $EXTS; do q "CREATE EXTENSION IF NOT EXISTS \"$e\" WITH SCHEMA $EXT_SCHEMA" >/dev/null || fail "extension $e"; done
WRONG="$(q "/*check:extschema*/ select count(*) from pg_extension x join pg_namespace n on n.oid=x.extnamespace where x.extname in ($(printf "'%s'," $EXTS | sed 's/,$//')) and n.nspname <> '$EXT_SCHEMA'")"
[ "$WRONG" = 0 ] || fail "$WRONG extension(s) pre-exist outside schema $EXT_SCHEMA"
echo "step 1 ok: extensions in $EXT_SCHEMA: $EXTS"

# ---- Step 2: auth stub (and the owner-approved helpers, if D1 is approved) ----------------------------------------------
pq -q -v ON_ERROR_STOP=1 --single-transaction -f "$STUB" >/dev/null || fail "auth stub"
echo "step 2 ok: auth stub (auth.users)"
if [ "${AUTH_HELPERS:-}" = approved ]; then
  [ "$(sha256sum "$HELPERS" | cut -d' ' -f1)" = "$HELPERS_SHA" ] || fail "auth helpers checksum mismatch"
  pq -q -v ON_ERROR_STOP=1 --single-transaction -f "$HELPERS" >/dev/null || fail "auth helpers"
  echo "step 2b ok: auth-helpers-production-definitions.sql (roles, auth.uid/jwt/role/email)"
fi

# ---- Step 3: preconditions the dump references must exist (read-only) ----------------------------------------------------
MISS=""
for r in anon authenticated service_role; do
  grep -qE "(^|[^a-z_])$r([^a-z_]|$)" "$DUMP_FILE" || continue
  [ "$(q "/*pre:role*/ select (to_regrole('$r') is not null)::text")" = true ] || MISS="$MISS role:$r"; done
for f in uid jwt role email; do
  grep -qE "auth\.$f\(\)" "$DUMP_FILE" || continue
  [ "$(q "/*pre:func*/ select (to_regprocedure('auth.$f()') is not null)::text")" = true ] || MISS="$MISS func:auth.$f()"; done
for s in storage; do
  grep -qE "(^|[^a-z_])$s\." "$DUMP_FILE" || continue
  [ "$(q "/*pre:schema*/ select (to_regnamespace('$s') is not null)::text")" = true ] || MISS="$MISS schema:$s"; done
[ -z "$MISS" ] || { echo "REFUSED: preconditions missing before load:$MISS (owner decision D1/D3); public untouched" >&2; exit 2; }
echo "step 3 ok: roles, auth helpers, schemas referenced by the dump exist"

# ---- Step 4: load the dump in one transaction --------------------------------------------------------------------------
pq -q -v ON_ERROR_STOP=1 --single-transaction -f "$DUMP_FILE" >/dev/null || fail "dump load rolled back (see error above)"
echo "step 4 ok: dump loaded"

# ---- Step 5: object counts ----------------------------------------------------------------------------------------------
CNT="$(q "/*count*/ select format('tables=%s views=%s matviews=%s sequences=%s functions=%s indexes=%s triggers=%s policies=%s fks=%s fks_to_auth_users=%s enums=%s',
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p')),
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v'),
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='m'),
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='S'),
 (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
 (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('i','I')),
 (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal),
 (select count(*) from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
 (select count(*) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname='public' and k.contype='f'),
 (select count(*) from pg_constraint k join pg_namespace n on n.oid=k.connamespace where n.nspname='public' and k.contype='f' and k.confrelid=to_regclass('auth.users')),
 (select count(*) from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typtype='e'))")" \
  || { echo "FAILED: count query" >&2; exit 3; }
echo "counts: $CNT"
GOT_T="$(printf '%s' "$CNT" | sed -nE 's/^tables=([0-9]+) .*/\1/p')"
[ "$GOT_T" = "$EXP_TABLES" ] || { echo "MISMATCH: tables=$GOT_T, dump has $EXP_TABLES CREATE TABLE" >&2; exit 3; }
echo "ok: restore complete, tables match dump ($EXP_TABLES)"

# ---- Step 6: post-restore parity (read-only) -------------------------------------------------------------------------------
pq -q -At -f "$HERE/sql/host-exclusion-check.sql" > "$HERE/host-exclusion.out" || { echo "FAILED: host exclusion query" >&2; exit 3; }
awk -F'|' 'NF==2 && $2 ~ /^[0-9]+$/ {s+=$2} END {exit s!=0}' "$HERE/host-exclusion.out" || { echo "FAILED: production reference after restore" >&2; exit 3; }
echo "step 6a ok: production host exclusion clean"
pq -q -At -f "$HERE/sql/parity-probe.sql" > "$HERE/target-counts.out" || { echo "FAILED: parity probe" >&2; exit 3; }
python3 "$HERE/parity-compare.py" "$HERE/source-baseline-2026-11-17.txt" "$HERE/target-counts.out" || { echo "PARITY: unexplained mismatch" >&2; exit 3; }
pq -q -At -F '|' -f "$HERE/sql/parity-definitions.sql" > "$HERE/staging-fk-definitions.out" || { echo "FAILED: FK definition query" >&2; exit 3; }
python3 "$HERE/parity-definitions.py" "$HERE/source-auth-fk-inventory.tsv" "$HERE/staging-fk-definitions.out" || { echo "PARITY: FK definition mismatch" >&2; exit 3; }
echo "ok: schema-only restore accepted by count and FK-definition parity"
