#!/usr/bin/env bash
# VTID-05803 executor for the existing task family vitana-staging-role-provision (command override).
# Replaces RUNBOOK step 1-5. Every step prints "STEP <id> start|ok|FAIL rc=<n>" so one CloudWatch read shows where
# a run stopped. Secrets are read from the environment the task definition injects and are never printed.
#
# Why this replaces schema-restore.sh: the eight files in the archive are DELTA scripts written for a target that a
# DMS full load had already populated (aurora-cutover-auth-bridge.sql line 1 needs public.app_users). On the empty
# staging database the first file fails, and schema-restore.sh's gate 2 (public must be empty) guarantees that.
# This runner creates the base schema from a schema-only dump of the source instead, then applies the two package
# files that are still needed on top (auth bridge, outbox).
#
# Container command: see RUNBOOK-v2.txt (bootstrap fetches the .b64 from S3, decodes, checks sha256, extracts, runs this).
# Env (names only):
#   MODE            probe (default, read-only) | restore
#   PGHOST PGUSER PGPASSWORD [PGDATABASE=vitana]     staging writer, DDL-capable role for MODE=restore
#   SOURCE_DATABASE_URL   Supabase direct or session-pooler URL (port 5432; the transaction pooler breaks pg_dump)
#   APP_LOGIN_ROLE  optional login role that must be able to SET ROLE anon/authenticated/service_role (default authenticator)
set -uo pipefail
export PGDATABASE="${PGDATABASE:-vitana}" PGSSLMODE="${PGSSLMODE:-require}" PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"
MODE="${MODE:-probe}"
W="${WORKDIR:-/tmp/vtid-05803}"
OUT="$W/out"
mkdir -p "$W" "$OUT" || { echo "STEP 0 FAIL rc=1 cannot create $W"; exit 10; }
FAILS=0

step() { echo "STEP $1 start: $2"; }
ok()   { echo "STEP $1 ok${2:+: $2}"; }
fail() { echo "STEP $1 FAIL rc=$2${3:+: $3}"; FAILS=$((FAILS + 1)); }
die()  { fail "$@"; echo "RESULT: stopped at step $1"; exit 20; }
src()  { psql "$SOURCE_DATABASE_URL" -X -v ON_ERROR_STOP=1 "$@"; }
stg()  { psql -X -v ON_ERROR_STOP=1 "$@"; }

# ---------- 0: tools and inputs (diagnoses the earlier exit code 2) ----------
step 0 "preflight"
echo "  shell=$BASH_VERSION mode=$MODE"
for t in psql pg_dump pg_restore awk comm sort; do
  if command -v "$t" >/dev/null 2>&1; then echo "  tool $t: $("$t" --version 2>&1 | head -1)"; else echo "  tool $t: MISSING"; fi
done
for v in PGHOST PGUSER PGPASSWORD SOURCE_DATABASE_URL; do
  if [ -n "${!v:-}" ]; then echo "  env $v: set"; else echo "  env $v: unset"; fi
done
echo "  PGHOST=${PGHOST:-} PGDATABASE=$PGDATABASE"
for t in psql awk comm sort; do command -v "$t" >/dev/null 2>&1 || die 0 127 "required tool $t missing"; done
if [ "$MODE" = restore ]; then
  for t in pg_dump pg_restore; do command -v "$t" >/dev/null 2>&1 || die 0 127 "MODE=restore needs $t"; done
fi
ok 0

# ---------- 1: target guard (staging writer only) ----------
step 1 "target guard"
case "${PGHOST:-}" in
  vitana-aurora-staging.cluster-*|vitana-aurora-staging-writer.*) ;;
  *) die 1 1 "PGHOST is not the Aurora staging writer" ;;
esac
case "$PGHOST" in *prod*|*rehearsal*|*awsdr*|*postgres-staging*) die 1 1 "non-staging name in PGHOST" ;; esac
ok 1 "$PGHOST"

# ---------- 2: package files (the bootstrap command already fetched, decoded, checksummed and extracted it) ----------
step 2 "package files"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
A="$ROOT/scripts/aws"; D="$ROOT/docs/validation/VTID-05803"; INV="$D/inventory.sql"
SHIM="$ROOT/scripts/aurora/migrations/0001_auth_shim.sql"
for f in "$INV" "$D/source-exclusions.sql" "$D/source-grants.sql" "$SHIM" "$A/aurora-cutover-auth-bridge.sql" "$A/aurora-cutover-outbox.sql"; do
  [ -f "$f" ] || die 2 1 "missing ${f#$ROOT/}"
done
ok 2 "root=$ROOT"

# ---------- 3: staging connection (independent of the restore) ----------
step 3 "staging connect (read-only)"
stg -At -c "SET default_transaction_read_only=on; SELECT current_database(), current_user, inet_server_addr(), split_part(version(),' ',2), (SELECT count(*) FROM information_schema.tables WHERE table_schema='public'), (SELECT rolsuper OR pg_has_role(current_user,'rds_superuser','member') FROM pg_roles WHERE rolname=current_user), has_database_privilege(current_database(),'CREATE')" \
  > "$OUT/stg-conn.txt" 2>"$OUT/stg-conn.err"; rc=$?
[ "$rc" = 0 ] || die 3 "$rc" "$(head -c 300 "$OUT/stg-conn.err")"
IFS='|' read -r S_DB S_USER S_IP S_VER S_TABLES S_SUPER S_CREATE < <(tail -n 1 "$OUT/stg-conn.txt")  # last line: skip the SET echo
ok 3 "db=$S_DB user=$S_USER ip=$S_IP pg=$S_VER public_tables=$S_TABLES rds_superuser=$S_SUPER db_create=$S_CREATE"

# ---------- 4: source connection (read-only) ----------
step 4 "source connect (read-only)"
[ -n "${SOURCE_DATABASE_URL:-}" ] || die 4 1 "SOURCE_DATABASE_URL unset"
src -At -c "SET default_transaction_read_only=on; SELECT current_database(), split_part(version(),' ',2), (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')" \
  > "$OUT/src-conn.txt" 2>"$OUT/src-conn.err"; rc=$?
[ "$rc" = 0 ] || die 4 "$rc" "$(head -c 300 "$OUT/src-conn.err" | sed -E 's#postgres(ql)?://[^ ]*#<url>#g')"
IFS='|' read -r R_DB R_VER R_TABLES < <(tail -n 1 "$OUT/src-conn.txt")  # last line: skip the SET echo
DUMP_MAJOR=$(pg_dump --version 2>/dev/null | grep -oE '[0-9]+' | head -1)
ok 4 "db=$R_DB pg=$R_VER public_base_tables=$R_TABLES pg_dump_major=${DUMP_MAJOR:-none}"

# ---------- 5: baseline inventories ----------
step 5 "inventories"
F5=$FAILS
src -A -t -F '|' -f "$INV" 2>"$OUT/src-inv.err" | grep -v -x SET | LC_ALL=C sort > "$OUT/source.inv" || fail 5 $? "source inventory: $(head -c 200 "$OUT/src-inv.err")"
stg -A -t -F '|' -f "$INV" 2>"$OUT/stg-inv.err" | grep -v -x SET | LC_ALL=C sort > "$OUT/staging-before.inv" || fail 5 $? "staging inventory: $(head -c 200 "$OUT/stg-inv.err")"
summ() { cut -d'|' -f1 "$1" | sort | uniq -c | awk '{printf "%s=%s ", $2, $1}'; }
echo "  source:  $(summ "$OUT/source.inv")"
echo "  staging: $(summ "$OUT/staging-before.inv")"
[ "$FAILS" = "$F5" ] && ok 5

if [ "$MODE" != restore ]; then
  echo "RESULT: probe finished, failures=$FAILS (MODE=restore runs steps 6-9)"
  exit $(( FAILS > 0 ? 30 : 0 ))
fi

# ---------- 6: restore gates ----------
step 6 "restore gates"
[ "$S_TABLES" = 0 ] || die 6 1 "staging public already has $S_TABLES relations; not overwriting"
[ "$S_SUPER" = t ] || die 6 1 "PGUSER $S_USER is not rds_superuser (needed for CREATE EXTENSION and role grants)"
R_MAJOR=$(echo "$R_VER" | cut -d. -f1)
[ "${DUMP_MAJOR:-0}" -ge "$R_MAJOR" ] || die 6 1 "pg_dump $DUMP_MAJOR is older than source $R_MAJOR"
ok 6

# ---------- 7: build the restore (all from the source catalog, schema only) ----------
step 7 "build restore"
src -A -t -F '|' -f "$D/source-exclusions.sql" > "$OUT/exclusions.raw" 2>"$OUT/excl.err" || die 7 $? "exclusions: $(head -c 200 "$OUT/excl.err")"
grep -v -x SET "$OUT/exclusions.raw" > "$OUT/exclusions.txt" || true
src -A -t -f "$D/source-grants.sql" > "$OUT/grants.raw" 2>"$OUT/grants.err" || die 7 $? "grants: $(head -c 200 "$OUT/grants.err")"
grep -v -x SET "$OUT/grants.raw" > "$OUT/grants.sql" || true
# extensions the source uses that Aurora offers; never pg_cron, pg_net or Supabase-internal ones
src -A -t -F '|' -c "SET default_transaction_read_only=on; SELECT e.extname, n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname <> 'plpgsql' ORDER BY 1" > "$OUT/src-ext.raw" || die 7 $? "extension list"
grep -v -x SET "$OUT/src-ext.raw" > "$OUT/src-ext.txt" || true
stg -A -t -c "SELECT name FROM pg_available_extensions" > "$OUT/stg-avail.txt" || die 7 $? "available extensions"
: > "$OUT/extensions.sql"
while IFS='|' read -r ext sch; do
  case "$ext" in pg_cron|pg_net|pgsodium|supabase_vault|pg_graphql|pgjwt|pg_stat_monitor|wrappers|pg_tle|pgaudit) echo "  skip extension $ext (excluded)"; continue ;; esac
  if grep -qx "$ext" "$OUT/stg-avail.txt"; then
    printf 'CREATE SCHEMA IF NOT EXISTS %s;\nCREATE EXTENSION IF NOT EXISTS "%s" WITH SCHEMA %s;\n' "$sch" "$ext" "$sch" >> "$OUT/extensions.sql"
  else echo "  skip extension $ext (not available on Aurora)"; fi
done < "$OUT/src-ext.txt"
# schema-only dump of public; ACLs come from grants.sql, owners default to the restoring role
pg_dump "$SOURCE_DATABASE_URL" --schema-only --schema=public --no-owner --no-privileges --no-publications \
  --no-subscriptions --no-security-labels -Fc -f "$W/public.dump" 2>"$OUT/pg_dump.err" || die 7 $? "pg_dump: $(head -c 300 "$OUT/pg_dump.err" | sed -E 's#postgres(ql)?://[^ ]*#<url>#g')"
pg_restore -l "$W/public.dump" > "$OUT/toc.full" || die 7 $? "pg_restore -l"
awk -F'|' 'FNR==NR { k[$1"|"$3]=1; t[$1"|"$2]=1; next }
  / SCHEMA - public / || / COMMENT - SCHEMA public / { next }
  / FK CONSTRAINT public / { n=split($0,a," "); if (k["fk|"a[n-1]]) next }
  / TRIGGER public /       { n=split($0,a," "); if (k["trigger|"a[n-1]]) next }
  / (MATERIALIZED )?VIEW public / || / COMMENT public (MATERIALIZED )?VIEW / {
      n=split($0,a," "); if (k["view|"a[n-1]]) next }
  { print }' "$OUT/exclusions.txt" "$OUT/toc.full" > "$OUT/toc.keep"
pg_restore -L "$OUT/toc.keep" -f "$OUT/public.sql" "$W/public.dump" || die 7 $? "pg_restore to SQL"
grep -qiE 'cron\.schedule|^COPY |^INSERT INTO' "$OUT/public.sql" && die 7 1 "restore SQL contains cron or data statements"
echo "  toc entries: full=$(grep -vc '^;' "$OUT/toc.full") kept=$(grep -vc '^;' "$OUT/toc.keep") excluded: $(cut -d'|' -f1 "$OUT/exclusions.txt" | sort | uniq -c | tr -s ' ' | tr '\n' ' ')"
APP="${APP_LOGIN_ROLE:-authenticator}"
cat > "$OUT/roles.sql" <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$APP') THEN EXECUTE 'GRANT anon, authenticated, service_role TO $APP'; END IF;
END \$\$;
SQL
ok 7

# ---------- 8: apply in ONE transaction (any error rolls everything back, so a re-run starts clean) ----------
step 8 "apply (single transaction)"
stg -1 -q -f "$OUT/roles.sql" -f "$SHIM" -f "$OUT/extensions.sql" -f "$OUT/public.sql" -f "$OUT/grants.sql" \
  -f "$A/aurora-cutover-auth-bridge.sql" -f "$A/aurora-cutover-outbox.sql" >"$OUT/apply.log" 2>&1; rc=$?
tail -n 5 "$OUT/apply.log"
[ "$rc" = 0 ] || die 8 "$rc" "rolled back; staging unchanged"
ok 8

# ---------- 9: parity (definitions, object by object; no hardcoded counts) ----------
step 9 "parity"
stg -A -t -F '|' -f "$INV" | grep -v -x SET | LC_ALL=C sort > "$OUT/staging-after.inv" || fail 9 $? "staging inventory"
# Expected = source inventory minus the objects source-exclusions.sql deliberately leaves out.
awk -F'|' 'FNR==NR { if ($1=="fk") ex["constraint|" $2 "." $3]=1; else if ($1=="trigger") ex["trigger|" $2 "." $3]=1;
                          else if ($1=="view") vw[$2]=1; next }
  { k=$1"|"$2; if (k in ex) next; b=$2; sub(/[.>(].*$/, "", b); if (b in vw) next; print }' \
  "$OUT/exclusions.txt" "$OUT/source.inv" | LC_ALL=C sort > "$OUT/source-expected.inv"
# Join on kind|identity: MISSING = on source only; CHANGED = both sides, different definition; EXTRA = staging only.
awk -F'|' 'FNR==NR { src[$1"|"$2]=$0; next } { stg[$1"|"$2]=$0 }
  END {
    for (k in src) if (!(k in stg)) print "MISSING\t" src[k];
    for (k in src) if ((k in stg) && src[k] != stg[k]) print "CHANGED\t" src[k] "\t=> " stg[k];
    for (k in stg) if (!(k in src)) print "EXTRA\t" stg[k] }' \
  "$OUT/source-expected.inv" "$OUT/staging-after.inv" | LC_ALL=C sort > "$OUT/parity.report"
N_MISS=$(grep -c '^MISSING' "$OUT/parity.report"); N_CHG=$(grep -c '^CHANGED' "$OUT/parity.report")
N_EXP=0; N_UNEXP=0
while IFS= read -r line; do
  case "$line" in
    EXTRA*)
      id=$(printf '%s' "$line" | cut -f2 | cut -d'|' -f2); b=$(printf '%s' "$id" | sed -E 's/_pkey$//; s/[.>(].*$//')
      if grep -q -F -- "$b" "$SHIM" "$A/aurora-cutover-auth-bridge.sql" "$A/aurora-cutover-outbox.sql"; then N_EXP=$((N_EXP+1))
      else N_UNEXP=$((N_UNEXP+1)); echo "  UNEXPLAINED $line"; fi ;;
  esac
done < "$OUT/parity.report"
echo "  source expected objects: $(wc -l < "$OUT/source-expected.inv")   staging objects: $(wc -l < "$OUT/staging-after.inv")"
echo "  missing_on_staging=$N_MISS  changed_definition=$N_CHG  extra_from_package=$N_EXP  extra_unexplained=$N_UNEXP"
echo "  auth.users foreign keys: source=$(grep -c '^constraint|.*REFERENCES auth\.users(' "$OUT/source.inv")  staging=$(grep -c '^constraint|.*REFERENCES auth\.users(' "$OUT/staging-after.inv")"
grep '^MISSING' "$OUT/parity.report" | head -20 | sed 's/^/  /'
grep '^CHANGED' "$OUT/parity.report" | head -20 | sed 's/^/  /'
stg -At -c "SELECT 'auth_users_rows=' || (SELECT count(*) FROM auth.users)" | sed 's/^/  /'
stg -At -c "SELECT 'public_rows_total=' || coalesce(sum(n_live_tup),0) FROM pg_stat_user_tables WHERE schemaname='public'" | sed 's/^/  /'
[ "$N_MISS" = 0 ] && [ "$N_CHG" = 0 ] && [ "$N_UNEXP" = 0 ] || fail 9 1 "parity: missing=$N_MISS changed=$N_CHG unexplained=$N_UNEXP"
[ "$FAILS" = 0 ] || die 9 1 "parity failed"
ok 9
echo "RESULT: restore finished, failures=$FAILS"
exit $(( FAILS > 0 ? 30 : 0 ))
