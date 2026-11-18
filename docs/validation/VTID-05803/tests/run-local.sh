#!/usr/bin/env bash
# VTID-05803 local tests for stage-exec.sh against a real PostgreSQL 17 server (with pgvector and TLS).
# Usage: PG_BIN=/path/to/pg17/bin PGTEST_PORT=55432 bash run-local.sh
# The server must accept superuser "postgres" over TLS on 127.0.0.1:$PGTEST_PORT with trust or password auth.
# Nothing here touches AWS or Supabase: both "source" and "staging" are scratch databases on that local server.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
export PATH="${PG_BIN:?PG_BIN required}:$PATH"
PORT="${PGTEST_PORT:-55432}"
SU="host=127.0.0.1 port=$PORT user=postgres sslmode=require"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PASS=0; FAILN=0
pass() { echo "PASS $1"; PASS=$((PASS + 1)); }
failt() { echo "FAIL $1${2:+: $2}"; FAILN=$((FAILN + 1)); }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else failt "$name"; fi; }
su() { psql "$SU dbname=${DB:-postgres}" -X -q -v ON_ERROR_STOP=1 -At "$@"; }

reset_dbs() {
  DB=postgres su -c "DROP DATABASE IF EXISTS src WITH (FORCE)" -c "DROP DATABASE IF EXISTS vitana WITH (FORCE)" \
    -c "CREATE DATABASE src" -c "CREATE DATABASE vitana" >/dev/null
  DB=postgres su -c "DO \$\$ DECLARE r text; BEGIN FOREACH r IN ARRAY ARRAY['src_reader','supabase_auth_admin','supabase_admin','anon','authenticated','service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('DROP OWNED BY %I CASCADE', r); EXECUTE format('DROP ROLE %I', r); END IF; END LOOP; END \$\$" >/dev/null 2>&1 || true
  DB=src su -f "$HERE/fixture-source.sql" >/dev/null || { echo "fixture-source failed"; exit 2; }
  DB=vitana su -f "$HERE/fixture-staging.sql" >/dev/null || { echo "fixture-staging failed"; exit 2; }
}
# extract the package exactly as the bootstrap does
PKG_TGZ="$HERE/../package/vtid-05803-exec-v2.tar.gz"
mkdir -p "$TMP/pkg" && tar -xzf "$PKG_TGZ" -C "$TMP/pkg" || { echo "cannot extract $PKG_TGZ"; exit 2; }
EXEC="$TMP/pkg/docs/validation/VTID-05803/stage-exec.sh"
STAGING_HOST=vitana-aurora-staging.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com
SRC_URL="postgresql://src_reader:src-pass@127.0.0.1:$PORT/src"
run() {  # run the executor with a clean env; extra VAR=value args override
  env -i PATH="$PATH" HOME="$TMP" WORKDIR="$TMP/w$RANDOM" PGPORT="$PORT" PGHOST="$STAGING_HOST" \
    VTID05803_TEST_HOSTADDR=127.0.0.1 PGUSER=stg_master PGPASSWORD=stg-pass SOURCE_DATABASE_URL="$SRC_URL" "$@" \
    bash "$EXEC"
}
stg_objects() { DB=vitana su -c "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e')) + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e'))"; }

reset_dbs

# 1. production host rejected before any connection
out=$(run PGHOST=vitana-aurora-prod.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com 2>&1); rc=$?
check "prod-host-rejected" grep -q 'STEP 1 FAIL rc=1: PGHOST is not the Aurora staging writer' <<<"$out"
check "prod-host-exit-20" test "$rc" = 20
out=$(run PGHOST=vitana-aurora-staging.cluster-x.prod.eu-central-1.rds.amazonaws.com 2>&1)
check "prod-substring-rejected" grep -q 'STEP 1 FAIL' <<<"$out"
out=$(run PGHOST=vitana-postgres-staging.cfk228aiedf3.eu-central-1.rds.amazonaws.com 2>&1)
check "legacy-staging-instance-rejected" grep -q 'STEP 1 FAIL' <<<"$out"
out=$(run PGHOSTADDR=10.0.0.1 2>&1)
check "hostaddr-override-rejected" grep -q 'PGHOSTADDR is not allowed' <<<"$out"
check "no-connection-before-guard" bash -c "! grep -q 'STEP 3' <<<\"\$1\"" _ "$out"

# 2. staging host accepted, probe is read-only and passes
before=$(stg_objects)
out=$(run MODE=probe 2>&1); rc=$?
check "probe-exit-0" test "$rc" = 0
check "probe-steps-0-to-5-ok" bash -c 'for s in 0 1 2 3 4 5; do grep -q "^STEP $s ok" <<<"$1" || exit 1; done' _ "$out"
check "probe-staging-empty-reported" grep -q 'public_objects=0 rds_superuser=t' <<<"$out"
check "probe-changes-nothing" test "$(stg_objects)" = "$before"
check "probe-no-secret-in-log" bash -c "! grep -qE 'stg-pass|src-pass' <<<\"\$1\"" _ "$out"

# 3. restore refused for a non-admin staging role
out=$(run MODE=restore PGUSER=not_admin PGPASSWORD=na-pass 2>&1)
check "non-admin-rejected" grep -q 'STEP 6 FAIL rc=1: PGUSER not_admin is not rds_superuser' <<<"$out"
check "non-admin-nothing-applied" test "$(stg_objects)" = 0

# 4. rollback: a failing package file leaves staging exactly empty
cp -a "$TMP/pkg" "$TMP/pkgbad"; echo 'SELECT 1/0;' >> "$TMP/pkgbad/scripts/aws/aurora-cutover-outbox.sql"
out=$(env -i PATH="$PATH" HOME="$TMP" WORKDIR="$TMP/wbad" PGPORT="$PORT" PGHOST="$STAGING_HOST" VTID05803_TEST_HOSTADDR=127.0.0.1 \
  PGUSER=stg_master PGPASSWORD=stg-pass SOURCE_DATABASE_URL="$SRC_URL" MODE=restore bash "$TMP/pkgbad/docs/validation/VTID-05803/stage-exec.sh" 2>&1)
check "failure-reported-at-step-8" grep -q 'STEP 8 FAIL rc=3: rolled back; staging unchanged' <<<"$out"
check "failure-error-shown" grep -q 'division by zero' <<<"$out"
check "rollback-leaves-public-empty" test "$(stg_objects)" = 0
check "rollback-leaves-auth-bridge-absent" test "$(DB=vitana su -c "SELECT to_regclass('public.auth_user_fk_map') IS NULL")" = t

# 5. restore succeeds with parity
W5="$TMP/w5"
out=$(run MODE=restore WORKDIR="$W5" 2>&1); rc=$?
echo "$out" | grep -E '^STEP [0-9] (ok|FAIL)|RESULT|unexpected|rows_total|exclusions by kind|toc entries'
check "restore-exit-0" test "$rc" = 0
check "restore-steps-0-to-9-ok" bash -c 'for s in 0 1 2 3 4 5 6 7 8 9; do grep -q "^STEP $s ok" <<<"$1" || exit 1; done' _ "$out"
check "parity-no-unexpected" grep -q 'STEP 9 ok: parity: no unexpected differences, 0 rows, role switch ok' <<<"$out"
check "restore-no-secret-in-log" bash -c "! grep -rqE 'stg-pass|src-pass' \"\$1\" <<<\"\$2\"" _ "$W5" "$out"
q() { DB=vitana su -c "$1"; }
qs() { DB=src su -c "$1"; }
# no data
check "no-member-rows" test "$(q "SELECT (SELECT count(*) FROM public.app_users)+(SELECT count(*) FROM public.profiles)+(SELECT count(*) FROM public.posts)+(SELECT count(*) FROM public.memberships)+(SELECT count(*) FROM public.events)")" = 0
check "matview-not-populated" test "$(q "SELECT relispopulated FROM pg_class WHERE oid='public.mv_tenant_sizes'::regclass")" = f
check "sequence-not-advanced" test "$(q "SELECT last_value||'/'||is_called FROM public.ticket_no_seq")" = "1000/false"
check "restore-sql-has-no-copy" bash -c "! grep -qE '^COPY |^INSERT ' \"\$1\"" _ "$W5/out/public.sql"
# objects carried
for t in tenants app_users profiles memberships posts events events_2026 service_bot_accounts user_discount_codes storage_refs; do
  check "table-$t" test "$(q "SELECT to_regclass('public.$t') IS NOT NULL")" = t
done
check "views-carried" test "$(q "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('post_counts','mv_tenant_sizes')")" = 2
check "enum-and-domain" test "$(q "SELECT count(*) FROM pg_type WHERE typnamespace='public'::regnamespace AND typname IN ('member_mood','short_text')")" = 2
check "vector-column" test "$(q "SELECT format_type(atttypid, atttypmod) FROM pg_attribute WHERE attrelid='public.profiles'::regclass AND attname='embedding'")" = "vector(3)"
check "hnsw-index" test "$(q "SELECT count(*) FROM pg_indexes WHERE indexname='profiles_embedding_hnsw'")" = 1
check "generated-column" test "$(q "SELECT attgenerated FROM pg_attribute WHERE attrelid='public.profiles'::regclass AND attname='name_lower'")" = s
check "identity-column" test "$(q "SELECT attidentity FROM pg_attribute WHERE attrelid='public.memberships'::regclass AND attname='id'")" = a
check "public-fks-kept" test "$(q "SELECT count(*) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace")" = "$(qs "SELECT count(*) FROM pg_constraint c JOIN pg_class f ON f.oid=c.confrelid WHERE c.contype='f' AND c.connamespace='public'::regnamespace AND f.relnamespace='public'::regnamespace")"
check "trigger-public-kept" test "$(q "SELECT count(*) FROM pg_trigger WHERE tgname IN ('posts_touch','user_discount_codes_welcome')")" = 2
# RLS and policies
check "rls-enabled-parity" test "$(q "SELECT string_agg(relname||':'||relrowsecurity||relforcerowsecurity, ',' ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') AND relname NOT IN ('auth_user_fk_map','auth_bridge_deleted_users','outbound_http_requests')")" = "$(qs "SELECT string_agg(relname||':'||relrowsecurity||relforcerowsecurity, ',' ORDER BY relname) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p')")"
check "policies-kept" test "$(q "SELECT string_agg(policyname||':'||permissive||':'||cmd||':'||array_to_string(roles,'+'), ',' ORDER BY policyname) FROM pg_policies WHERE schemaname='public' AND tablename NOT IN ('auth_user_fk_map','auth_bridge_deleted_users','outbound_http_requests')")" = "$(qs "SELECT string_agg(policyname||':'||permissive||':'||cmd||':'||array_to_string(roles,'+'), ',' ORDER BY policyname) FROM pg_policies WHERE schemaname='public' AND policyname NOT IN ('app_users_via_auth','app_users_auth_admin')")"
RLS_SQL="BEGIN; INSERT INTO public.tenants (id, slug) VALUES ('33333333-3333-3333-3333-333333333333','t'); INSERT INTO public.app_users (user_id, tenant_id) VALUES ('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333'); INSERT INTO public.profiles (user_id) VALUES ('11111111-1111-1111-1111-111111111111'); SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222'; SELECT 'other=' || count(*) FROM public.profiles; SET LOCAL request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111'; SELECT 'self=' || count(*) FROM public.profiles; ROLLBACK;"
check "rls-two-user-isolation" test "$(q "$RLS_SQL" | tr '\n' ' ')" = "other=0 self=1 "
check "rls-test-left-no-rows" test "$(q "SELECT count(*) FROM public.profiles")" = 0
# grants
grants() { DB=$1 su -c "SELECT string_agg(x, ',' ORDER BY x) FROM (SELECT c.relname||'>'||coalesce(r.rolname,'PUBLIC')||'='||a.privilege_type AS x FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a LEFT JOIN pg_roles r ON r.oid=a.grantee WHERE c.relnamespace='public'::regnamespace AND (r.rolname IN ('anon','authenticated','service_role') OR a.grantee=0) AND c.relname NOT IN ('member_emails','member_emails_short','mv_member_count','auth_user_fk_map','auth_bridge_deleted_users','outbound_http_requests','outbound_http_requests_id_seq')) s"; }
check "table-grants-parity" test "$(grants vitana)" = "$(grants src)"
check "function-grant-revoked" test "$(q "SELECT has_function_privilege('anon','public.admin_stats(uuid,integer)','EXECUTE')")" = f
check "function-grant-kept" test "$(q "SELECT has_function_privilege('service_role','public.admin_stats(uuid,integer)','EXECUTE')")" = t
check "authenticator-can-switch" test "$(q "SELECT pg_has_role('authenticator','authenticated','MEMBER') AND pg_has_role('authenticator','anon','MEMBER')")" = t
# exclusions
check "auth-fk-excluded" test "$(q "SELECT count(*) FROM pg_constraint WHERE conname='app_users_user_id_fkey'")" = 0
check "webhook-trigger-excluded" test "$(q "SELECT count(*) FROM pg_trigger WHERE tgname='posts_webhook'")" = 0
check "auth-views-excluded" test "$(q "SELECT count(*) FROM pg_class WHERE relnamespace='public'::regnamespace AND relname IN ('member_emails','member_emails_short','mv_member_count')")" = 0
check "function-on-excluded-view-excluded" test "$(q "SELECT count(*) FROM pg_proc WHERE proname='list_member_emails'")" = 0
check "auth-policy-excluded" test "$(q "SELECT count(*) FROM pg_policies WHERE policyname IN ('app_users_via_auth','app_users_auth_admin')")" = 0
check "storage-not-created" test "$(q "SELECT count(*) FROM pg_namespace WHERE nspname IN ('storage','supabase_functions')")" = 0
# outbound, cron, workers
check "outbox-replaced-pg-net" bash -c "! grep -q 'net.http_post' <<<\"\$1\"" _ "$(q "SELECT prosrc FROM pg_proc WHERE proname='notify_welcome_discount'")"
check "outbox-table-present" test "$(q "SELECT to_regclass('public.outbound_http_requests') IS NOT NULL")" = t
check "outbox-empty" test "$(q "SELECT count(*) FROM public.outbound_http_requests")" = 0
check "no-pg-cron-or-pg-net" test "$(q "SELECT count(*) FROM pg_extension WHERE extname IN ('pg_cron','pg_net','http')")" = 0
check "extensions-created" test "$(q "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension WHERE extname <> 'plpgsql'")" = "pgcrypto,uuid-ossp,vector"
check "auth-bridge-present" test "$(q "SELECT count(*) FROM pg_proc WHERE proname IN ('ensure_provisioned','auth_bridge_handle_deleted_user','auth_bridge_unprovisioned','provisioning_pre_request')")" = 4
check "default-auth-uid-works" test "$(q "SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef WHERE adrelid='public.posts'::regclass AND adnum=2")" = "auth.uid()"

# 6. second restore refused (non-empty)
out=$(run MODE=restore 2>&1)
check "rerun-refused-non-empty" grep -qE 'STEP 6 FAIL rc=1: staging public already has [0-9]+ objects' <<<"$out"

# 6b. an authenticator without role membership is reported, not silently accepted
W6="$TMP/w6"; cp -a "$W5" "$TMP/w5keep"
reset_dbs; DB=vitana su -c "REVOKE anon FROM authenticator" >/dev/null
out=$(run MODE=restore WORKDIR="$W6" 2>&1)
check "missing-role-switch-applies" grep -q '^STEP 8 ok' <<<"$out"
check "missing-role-switch-reported" grep -q 'STEP 9 FAIL rc=1: parity: unexpected_only_source=0 unexpected_only_staging=0 rows=0 role_switch=f' <<<"$out"
W5="$TMP/w5keep"

# 7. inventory comparison detects a real gap
DB=vitana su -c "DROP POLICY posts_read ON public.posts" -c "REVOKE SELECT ON public.tenants FROM anon" >/dev/null
cp "$W5/out/source.inv" "$TMP/s.inv"
psql "host=127.0.0.1 port=$PORT user=postgres sslmode=require dbname=vitana" -X -q -A -t -F '|' -f "$TMP/pkg/docs/validation/VTID-05803/inventory.sql" | LC_ALL=C sort > "$TMP/t.inv"
check "inventory-detects-missing-policy" grep -q '^policy|posts.posts_read|' <(LC_ALL=C comm -23 "$TMP/s.inv" "$TMP/t.inv")
check "inventory-detects-missing-grant" grep -q '^grant|tenants>anon|' <(LC_ALL=C comm -23 "$TMP/s.inv" "$TMP/t.inv")

# 8. bootstrap command from RUNBOOK-v2 (fake aws serving the committed .b64), probe mode
mkdir -p "$TMP/bin"
printf '#!/bin/bash\n[ "$1 $2" = "s3 cp" ] && cp "%s" "$5"\n' "$HERE/../package/vtid-05803-exec-v2.tar.gz.b64" > "$TMP/bin/aws"; chmod +x "$TMP/bin/aws"
CMD=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[2])' "$HERE/../package/bootstrap-command.json")
SHA=$(sha256sum "$PKG_TGZ" | cut -d' ' -f1)
reset_dbs
out=$(env -i PATH="$TMP/bin:$PATH" HOME="$TMP" PGPORT="$PORT" PGHOST="$STAGING_HOST" VTID05803_TEST_HOSTADDR=127.0.0.1 PGUSER=stg_master \
  PGPASSWORD=stg-pass SOURCE_DATABASE_URL="$SRC_URL" MODE=probe PKG_S3_URI=s3://vitana-code-index/vtid-05803/staging/vtid-05803-exec-v2.tar.gz.b64 \
  PKG_SHA256="$SHA" bash -c "$CMD" 2>&1); rc=$?
check "bootstrap-checksum-ok" grep -q 'p.tgz: OK' <<<"$out"
check "bootstrap-probe-result" grep -q 'RESULT: probe finished, failures=0' <<<"$out"
out=$(env -i PATH="$TMP/bin:$PATH" HOME="$TMP" PKG_S3_URI=s3://x/y PKG_SHA256=0000000000000000000000000000000000000000000000000000000000000000 bash -c "$CMD" 2>&1); rc=$?
check "bootstrap-bad-checksum-stops" test "$rc" != 0
check "bootstrap-bad-checksum-no-exec" bash -c "! grep -q 'STEP 0' <<<\"\$1\"" _ "$out"

# 9. bootstrap fallback for an image without aws or boto3: plain-HTTP GET of a presigned URL, still sha256-checked
if command -v python3 >/dev/null 2>&1 && ! (exec 3<>/dev/tcp/127.0.0.1/80) 2>/dev/null; then
  mkdir -p "$TMP/www/vtid-05803/staging" "$TMP/nobin"
  cp "$HERE/../package/vtid-05803-exec-v2.tar.gz.b64" "$TMP/www/vtid-05803/staging/"
  for t in bash sh base64 sha256sum tar gzip mkdir rm cat sed awk sort comm cut head grep wc tr uniq dirname env; do ln -sf "$(command -v $t)" "$TMP/nobin/$t"; done
  for t in psql pg_dump pg_restore; do ln -sf "$PG_BIN/$t" "$TMP/nobin/$t"; done
  (cd "$TMP/www" && exec python3 -m http.server 80 --bind 127.0.0.1 >/dev/null 2>&1) & HTTPD=$!; sleep 1
  out=$(env -i PATH="$TMP/nobin" HOME="$TMP" PGPORT="$PORT" PGHOST="$STAGING_HOST" VTID05803_TEST_HOSTADDR=127.0.0.1 PGUSER=stg_master \
    PGPASSWORD=stg-pass SOURCE_DATABASE_URL="$SRC_URL" MODE=probe PKG_S3_URI=s3://unused/key \
    PKG_HTTP_URL="http://127.0.0.1/vtid-05803/staging/vtid-05803-exec-v2.tar.gz.b64?X-Amz-Signature=test" PKG_SHA256="$SHA" bash -c "$CMD" 2>&1)
  kill "$HTTPD" 2>/dev/null
  check "bootstrap-http-fallback-checksum-ok" grep -q 'p.tgz: OK' <<<"$out"
  check "bootstrap-http-fallback-probe" grep -q 'RESULT: probe finished, failures=0' <<<"$out"
else
  echo "SKIP bootstrap-http-fallback (python3 missing or port 80 busy)"
fi

# 10. transaction-pooler URL is moved to the session port before connecting
out=$(run SOURCE_DATABASE_URL="postgresql://src_reader:src-pass@127.0.0.1:6543/src" 2>&1)
check "pooler-6543-rewritten" grep -q 'note: transaction pooler port 6543 rewritten to session port 5432' <<<"$out"
check "pooler-error-scrubbed" bash -c "! grep -q 'src-pass' <<<\"\$1\"" _ "$out"

echo "TOTAL pass=$PASS fail=$FAILN"
[ "$FAILN" = 0 ]
