#!/usr/bin/env bash
# VTID-05803 executor: schema-only restore of Supabase `public` into the EMPTY Aurora staging database, plus parity.
# Runs in the existing task family vitana-staging-role-provision (command override, see package/RUNBOOK-v2.txt).
# Every step prints "STEP <n> start|ok|FAIL rc=<n>" so one CloudWatch read shows where a run stopped.
# Secrets come from the environment the task definition injects and are never printed.
#
# Why not schema-restore.sh: its eight files are DELTA scripts for a target a DMS full load had already populated
# (aurora-cutover-auth-bridge.sql needs public.app_users). On an empty database the first file fails.
# Here the base schema comes from a live schema-only pg_dump of the source; then the auth bridge and the outbox are
# applied on top. Everything is applied in ONE transaction: any error rolls back all of it.
#
# Env (names only):
#   MODE                  probe (default; read-only on both sides) | restore
#   PGHOST                staging writer (vitana-aurora-staging.cluster-* or vitana-aurora-staging-writer.*)
#   PGUSER, PGPASSWORD    staging role; MODE=restore needs rds_superuser (the cluster master user)
#   PGDATABASE            default vitana
#   SOURCE_DATABASE_URL   Supabase URL (secret vitana/supabase/prod/database-url). Port 6543 (transaction pooler)
#                         is rewritten to 5432 (session pooler, same host and user): pg_dump needs a session.
#   APP_LOGIN_ROLE        login role that must be able to SET ROLE anon/authenticated/service_role (default authenticator)
#   VTID05803_TEST_HOSTADDR   local tests only: connect the guarded PGHOST name to this address (prints TEST MODE)
set -uo pipefail
export PGDATABASE="${PGDATABASE:-vitana}" PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"
case "${PGSSLMODE:-}" in verify-ca|verify-full) ;; *) export PGSSLMODE=require ;; esac
MODE="${MODE:-probe}"
W="${WORKDIR:-/tmp/vtid-05803}"
OUT="$W/out"
mkdir -p "$W" "$OUT" || { echo "STEP 0 FAIL rc=1: cannot create $W"; exit 10; }
FAILS=0

step() { echo "STEP $1 start: $2"; }
ok()   { echo "STEP $1 ok${2:+: $2}"; }
fail() { echo "STEP $1 FAIL rc=$2${3:+: $3}"; FAILS=$((FAILS + 1)); }
die()  { fail "$@"; echo "RESULT: stopped at step $1"; exit 20; }
scrub() { sed -E 's#postgres(ql)?://[^[:space:]]*#<url>#g; s#password=[^[:space:]]*#password=<hidden>#g' | head -c "${1:-400}"; }
src()  { psql "$SRC_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
stg()  { psql -X -q -v ON_ERROR_STOP=1 "$@"; }
summ() { cut -d'|' -f1 "$1" | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}'; }

# ---------- 0: tools and inputs ----------
step 0 "preflight"
echo "  shell=$BASH_VERSION mode=$MODE"
for t in psql pg_dump pg_restore awk sed comm sort; do
  if command -v "$t" >/dev/null 2>&1; then echo "  tool $t: $("$t" --version 2>&1 | head -1)"; else echo "  tool $t: MISSING"; fi
done
for v in PGHOST PGUSER PGPASSWORD SOURCE_DATABASE_URL; do
  if [ -n "${!v:-}" ]; then echo "  env $v: set"; else echo "  env $v: unset"; fi
done
echo "  PGHOST=${PGHOST:-} PGDATABASE=$PGDATABASE PGSSLMODE=$PGSSLMODE"
for t in psql awk sed comm sort; do command -v "$t" >/dev/null 2>&1 || die 0 127 "required tool $t missing"; done
case "$MODE" in
  probe) ;;
  restore) for t in pg_dump pg_restore; do command -v "$t" >/dev/null 2>&1 || die 0 127 "MODE=restore needs $t"; done ;;
  *) die 0 2 "MODE must be probe or restore" ;;
esac
ok 0

# ---------- 1: target guard (staging writer only) ----------
step 1 "target guard"
[ -z "${PGSERVICE:-}" ] && [ -z "${PGSERVICEFILE:-}" ] || die 1 1 "PGSERVICE/PGSERVICEFILE are not allowed"
if [ -n "${PGHOSTADDR:-}" ]; then die 1 1 "PGHOSTADDR is not allowed (it would bypass the host check)"; fi
case "${PGHOST:-}" in
  vitana-aurora-staging.cluster-*.eu-central-1.rds.amazonaws.com|vitana-aurora-staging-writer.*.eu-central-1.rds.amazonaws.com) ;;
  *) die 1 1 "PGHOST is not the Aurora staging writer" ;;
esac
case "$PGHOST" in *prod*|*rehearsal*|*awsdr*|*postgres-staging*|*,*) die 1 1 "non-staging name in PGHOST" ;; esac
if [ -n "${VTID05803_TEST_HOSTADDR:-}" ]; then echo "  TEST MODE: $PGHOST -> $VTID05803_TEST_HOSTADDR"; export PGHOSTADDR="$VTID05803_TEST_HOSTADDR"; fi
ok 1 "$PGHOST"

# ---------- 2: package files (the bootstrap already fetched, decoded, checksummed and extracted them) ----------
step 2 "package files"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
A="$ROOT/scripts/aws"; D="$ROOT/docs/validation/VTID-05803"; INV="$D/inventory.sql"
SHIM="$ROOT/scripts/aurora/migrations/0001_auth_shim.sql"
PKG_SQL=("$A/aurora-cutover-auth-bridge.sql" "$A/aurora-cutover-outbox.sql")
for f in "$INV" "$D/source-exclusions.sql" "$D/source-grants.sql" "$SHIM" "${PKG_SQL[@]}"; do
  [ -f "$f" ] || die 2 1 "missing ${f#"$ROOT"/}"
done
ok 2 "root=$ROOT"

# ---------- 3: staging connection (read-only) ----------
step 3 "staging connect (read-only)"
stg -At -c "SET default_transaction_read_only=on" -c "SELECT current_database(), current_user, inet_server_addr(), split_part(version(),' ',2),
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e'))
  + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')),
  (SELECT r.rolsuper OR EXISTS (SELECT 1 FROM pg_roles s WHERE s.rolname='rds_superuser' AND pg_has_role(current_user, s.oid, 'member'))
     FROM pg_roles r WHERE r.rolname=current_user),
  has_database_privilege(current_database(),'CREATE')" > "$OUT/stg-conn.txt" 2>"$OUT/stg-conn.err"; rc=$?
[ "$rc" = 0 ] || die 3 "$rc" "$(scrub < "$OUT/stg-conn.err")"
IFS='|' read -r S_DB S_USER S_IP S_VER S_OBJ S_SUPER S_CREATE < "$OUT/stg-conn.txt"
ok 3 "db=$S_DB user=$S_USER ip=$S_IP pg=$S_VER public_objects=$S_OBJ rds_superuser=$S_SUPER db_create=$S_CREATE"

# ---------- 4: source connection (read-only) ----------
step 4 "source connect (read-only)"
[ -n "${SOURCE_DATABASE_URL:-}" ] || die 4 1 "SOURCE_DATABASE_URL unset"
SRC_URL="$SOURCE_DATABASE_URL"
case "$SRC_URL" in
  *:6543/*|*:6543) SRC_URL="${SRC_URL/:6543/:5432}"; echo "  note: transaction pooler port 6543 rewritten to session port 5432" ;;
esac
case "$SRC_URL" in *sslmode=*) ;; *\?*) SRC_URL="$SRC_URL&sslmode=require" ;; *) SRC_URL="$SRC_URL?sslmode=require" ;; esac
src -At -c "SET default_transaction_read_only=on" -c "SELECT current_database(), split_part(version(),' ',2),
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')" \
  > "$OUT/src-conn.txt" 2>"$OUT/src-conn.err"; rc=$?
[ "$rc" = 0 ] || die 4 "$rc" "$(scrub < "$OUT/src-conn.err")"
IFS='|' read -r R_DB R_VER R_TABLES < "$OUT/src-conn.txt"
DUMP_MAJOR=$(pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
ok 4 "db=$R_DB pg=$R_VER public_base_tables=$R_TABLES pg_dump_major=${DUMP_MAJOR:-none}"

# ---------- 5: baseline inventories (catalog only) ----------
step 5 "inventories"
F5=$FAILS
src -A -t -F '|' -f "$INV" 2>"$OUT/src-inv.err" | LC_ALL=C sort > "$OUT/source.inv"; rc=${PIPESTATUS[0]}
[ "$rc" = 0 ] || fail 5 "$rc" "source inventory: $(scrub 200 < "$OUT/src-inv.err")"
stg -A -t -F '|' -f "$INV" 2>"$OUT/stg-inv.err" | LC_ALL=C sort > "$OUT/staging-before.inv"; rc=${PIPESTATUS[0]}
[ "$rc" = 0 ] || fail 5 "$rc" "staging inventory: $(scrub 200 < "$OUT/stg-inv.err")"
echo "  source:  $(summ "$OUT/source.inv")"
echo "  staging: $(summ "$OUT/staging-before.inv")"
[ "$FAILS" = "$F5" ] && ok 5

if [ "$MODE" = probe ]; then
  echo "RESULT: probe finished, failures=$FAILS (MODE=restore runs steps 6-9)"
  exit $(( FAILS > 0 ? 30 : 0 ))
fi
[ "$FAILS" = 0 ] || die 5 1 "inventories failed; not restoring"

# ---------- 6: restore gates ----------
step 6 "restore gates"
[ "$S_OBJ" = 0 ] || die 6 1 "staging public already has $S_OBJ objects; not overwriting"
[ "$S_SUPER" = t ] || die 6 1 "PGUSER $S_USER is not rds_superuser (needed for extensions and roles)"
R_MAJOR=$(echo "$R_VER" | grep -oE '^[0-9]+')
[ "${DUMP_MAJOR:-0}" -ge "${R_MAJOR:-99}" ] || die 6 1 "pg_dump ${DUMP_MAJOR:-none} is older than source ${R_MAJOR:-?}"
ok 6

# ---------- 7: build the restore SQL (from the source catalog, schema only) ----------
step 7 "build restore"
src -A -t -F '|' -f "$D/source-exclusions.sql" > "$OUT/exclusions.txt" 2>"$OUT/excl.err" || die 7 $? "exclusions: $(scrub 200 < "$OUT/excl.err")"
src -A -t -f "$D/source-grants.sql" > "$OUT/grants.all.sql" 2>"$OUT/grants.err" || die 7 $? "grants: $(scrub 200 < "$OUT/grants.err")"
# grants on excluded views and functions are dropped with their objects
awk -F'|' 'FNR == NR { if ($1 == "view") n[++c] = " public." $2 " "; if ($1 == "function") n[++c] = " public." $3 " "; next }
  { line = $0 " "; for (i = 1; i <= c; i++) if (index(line, n[i])) next; print }' "$OUT/exclusions.txt" "$OUT/grants.all.sql" > "$OUT/grants.sql"
src -A -t -F '|' -c "SET default_transaction_read_only=on" -c "SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname <> 'plpgsql' ORDER BY 1" \
  > "$OUT/src-ext.txt" 2>"$OUT/ext.err" || die 7 $? "extension list: $(scrub 200 < "$OUT/ext.err")"
stg -A -t -c "SELECT name FROM pg_available_extensions" > "$OUT/stg-avail.txt" || die 7 $? "available extensions"
: > "$OUT/extensions.sql"
while IFS='|' read -r ext sch; do
  # never cron, outbound HTTP, Supabase-internal or Aurora-absent extensions
  case "$ext" in pg_cron|pg_net|http|pgsodium|supabase_vault|pg_graphql|pgjwt|wrappers|pg_tle|pgaudit|pg_stat_monitor|index_advisor|hypopg|plpgsql_check|pgtap|pg_hashids|pg_jsonschema|pg_stat_statements)
    echo "  skip extension $ext (excluded)"; continue ;; esac
  if grep -qx "$ext" "$OUT/stg-avail.txt"; then
    printf 'CREATE SCHEMA IF NOT EXISTS "%s";\nCREATE EXTENSION IF NOT EXISTS "%s" WITH SCHEMA "%s";\n' "$sch" "$ext" "$sch" >> "$OUT/extensions.sql"
  else echo "  skip extension $ext (not available on staging)"; fi
done < "$OUT/src-ext.txt"
pg_dump "$SRC_URL" --schema-only --schema=public --no-owner --no-privileges --no-publications --no-subscriptions \
  --no-security-labels -Fc -f "$W/public.dump" 2>"$OUT/pg_dump.err" || die 7 $? "pg_dump: $(scrub < "$OUT/pg_dump.err")"
pg_restore -l "$W/public.dump" > "$OUT/toc.full" || die 7 $? "pg_restore -l"
# TOC line: "<id>; <cat> <oid> <DESC> <schema> <tag...> <owner>". Match " <DESC> public <tag> " exactly.
awk -F'|' '
  FNR == NR {
    if ($1 == "fk")       { n[++c] = " FK CONSTRAINT public " $2 " " $3 " "; n[++c] = " COMMENT public CONSTRAINT " $3 " ON " $2 " " }
    if ($1 == "trigger")  { n[++c] = " TRIGGER public " $2 " " $3 " ";       n[++c] = " COMMENT public TRIGGER " $3 " ON " $2 " " }
    if ($1 == "policy")   { n[++c] = " POLICY public " $2 " " $3 " ";        n[++c] = " COMMENT public POLICY " $3 " ON " $2 " " }
    if ($1 == "view")     { n[++c] = " VIEW public " $2 " "; n[++c] = " MATERIALIZED VIEW public " $2 " ";
                            n[++c] = " COMMENT public VIEW " $2 " "; n[++c] = " COMMENT public MATERIALIZED VIEW " $2 " ";
                            n[++c] = " COMMENT public COLUMN " $2 "."; n[++c] = " RULE public " $2 " "; n[++c] = " TRIGGER public " $2 " " }
    if ($1 == "index")    { n[++c] = " INDEX public " $2 " "; n[++c] = " COMMENT public INDEX " $2 " " }
    if ($1 == "function") { n[++c] = " FUNCTION public " $2 " "; n[++c] = " COMMENT public FUNCTION " $2 " " }
    next
  }
  / SCHEMA - public / || / COMMENT - SCHEMA public / { dropped++; next }
  /^;/ { print; next }
  { line = $0 " "; for (i = 1; i <= c; i++) if (index(line, n[i])) { dropped++; next }; print }
  END { print "; vtid05803 dropped=" dropped + 0 }' "$OUT/exclusions.txt" "$OUT/toc.full" > "$OUT/toc.keep"
pg_restore --no-owner --no-privileges --no-security-labels -L "$OUT/toc.keep" -f "$OUT/public.sql" "$W/public.dump" \
  || die 7 $? "pg_restore to SQL"
if grep -qiE '^COPY |^INSERT INTO|^SELECT pg_catalog\.setval|cron\.schedule|^CREATE PUBLICATION|^CREATE SUBSCRIPTION|^CREATE EVENT TRIGGER' "$OUT/public.sql"; then
  die 7 1 "restore SQL contains data, sequence values, cron, replication or event-trigger statements"
fi
echo "  toc entries: full=$(grep -vc '^;' "$OUT/toc.full") kept=$(grep -vc '^;' "$OUT/toc.keep") $(grep '^; vtid05803' "$OUT/toc.keep" | cut -c3-)"
echo "  exclusions by kind: $(summ "$OUT/exclusions.txt")"
APP="${APP_LOGIN_ROLE:-authenticator}"
cat > "$OUT/roles.sql" <<SQL
DO \$\$
DECLARE r text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=\$a\$$APP\$a\$) THEN
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF NOT pg_has_role(\$a\$$APP\$a\$, r, 'MEMBER') THEN
        BEGIN
          EXECUTE format('GRANT %I TO %I', r, \$a\$$APP\$a\$);
        EXCEPTION WHEN insufficient_privilege THEN
          RAISE WARNING 'vtid05803: cannot grant % to % (no ADMIN OPTION); PostgREST cannot switch to it', r, \$a\$$APP\$a\$;
        END;
      END IF;
    END LOOP;
  END IF;
END \$\$;
SQL
printf 'RESET ALL;\n' > "$OUT/reset.sql"
ok 7

# ---------- 8: apply in ONE transaction ----------
step 8 "apply (single transaction)"
stg -1 -f "$OUT/roles.sql" -f "$SHIM" -f "$OUT/extensions.sql" -f "$OUT/public.sql" -f "$OUT/reset.sql" -f "$OUT/grants.sql" \
  -f "$OUT/reset.sql" -f "${PKG_SQL[0]}" -f "$OUT/reset.sql" -f "${PKG_SQL[1]}" >"$OUT/apply.log" 2>&1; rc=$?
grep -E 'ERROR|FATAL' "$OUT/apply.log" | head -5 | scrub 1200
[ "$rc" = 0 ] || die 8 "$rc" "rolled back; staging unchanged"
ok 8

# ---------- 9: parity ----------
step 9 "parity"
stg -A -t -F '|' -f "$INV" 2>"$OUT/stg-inv2.err" | LC_ALL=C sort > "$OUT/staging-after.inv"; rc=${PIPESTATUS[0]}
[ "$rc" = 0 ] || die 9 "$rc" "staging inventory: $(scrub 200 < "$OUT/stg-inv2.err")"
LC_ALL=C comm -23 "$OUT/source.inv" "$OUT/staging-after.inv" > "$OUT/only-source.inv"
LC_ALL=C comm -13 "$OUT/source.inv" "$OUT/staging-after.inv" > "$OUT/only-staging.inv"
# names created or replaced by the package files (auth bridge, outbox) are expected to differ
grep -hoiE '(create table if not exists|create or replace function) public\.[a-z_0-9]+' "${PKG_SQL[@]}" \
  | awk '{print $NF}' | sed 's/^public\.//' | sort -u > "$OUT/package-names.txt"
classify() {  # $1 = diff file; prints unexpected lines
  awk -F'|' '
    FILENAME == ARGV[1] { pk[$1] = 1; next }
    FILENAME == ARGV[2] {
      if ($1 == "fk" || $1 == "trigger" || $1 == "policy") ex[($1 == "fk" ? "constraint" : $1) "|" $2 "." $3] = 1
      if ($1 == "view")     { vw[$2] = 1 }
      if ($1 == "index")    { ex["index|" $2] = 1 }
      if ($1 == "function") { ex["function|" $3] = 1; fn[$3] = 1 }
      next
    }
    {
      k = $1 "|" $2; name = $2; sub(/[.>(].*/, "", name)
      if ($1 == "extension" || $1 == "storage_relation") next
      if (k in ex) next
      if ($1 == "fgrant") { f = $2; sub(/>[^>]*$/, "", f); if (f in fn) next }
      if (name in vw && ($1 == "relation" || $1 == "column" || $1 == "viewdef" || $1 == "grant")) next
      for (p in pk) if (name == p || index(name, p "_") == 1) next
      print
    }' "$OUT/package-names.txt" "$OUT/exclusions.txt" "$1"
}
classify "$OUT/only-source.inv" > "$OUT/unexpected-only-source.inv"
classify "$OUT/only-staging.inv" > "$OUT/unexpected-only-staging.inv"
ROWS=$(stg -At -c "SELECT coalesce(sum((xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, tablename), false, true, '')))[1]::text::bigint), 0) FROM pg_tables WHERE schemaname='public'") \
  || die 9 $? "row count"
echo "  source:  $(summ "$OUT/source.inv")"
echo "  staging: $(summ "$OUT/staging-after.inv")"
echo "  only_source by kind:  $(summ "$OUT/only-source.inv")"
echo "  only_staging by kind: $(summ "$OUT/only-staging.inv")"
NU_S=$(wc -l < "$OUT/unexpected-only-source.inv"); NU_T=$(wc -l < "$OUT/unexpected-only-staging.inv")
echo "  --- unexpected only_source ($NU_S, first 80) ---"; cut -d'|' -f1,2 "$OUT/unexpected-only-source.inv" | head -80
echo "  --- unexpected only_staging ($NU_T, first 40) ---"; cut -d'|' -f1,2 "$OUT/unexpected-only-staging.inv" | head -40
SWITCH=$(stg -At -c "SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=\$a\$$APP\$a\$) THEN 'no-role'
  WHEN pg_has_role(\$a\$$APP\$a\$,'anon','MEMBER') AND pg_has_role(\$a\$$APP\$a\$,'authenticated','MEMBER') AND pg_has_role(\$a\$$APP\$a\$,'service_role','MEMBER') THEN 't' ELSE 'f' END") \
  || die 9 $? "role check"
echo "  rows_total_public=$ROWS"
echo "  $APP can switch to anon/authenticated/service_role: $SWITCH"
if [ "$NU_S" = 0 ] && [ "$NU_T" = 0 ] && [ "$ROWS" = 0 ] && [ "$SWITCH" = t ]; then ok 9 "parity: no unexpected differences, 0 rows, role switch ok"
else fail 9 1 "parity: unexpected_only_source=$NU_S unexpected_only_staging=$NU_T rows=$ROWS role_switch=$SWITCH"; fi
echo "RESULT: restore finished, failures=$FAILS"
exit $(( FAILS > 0 ? 30 : 0 ))
