#!/usr/bin/env bash
# Local delivery test for the self-hosted Supabase Realtime server on Aurora
# (VTID-05023, plan part 7a). No AWS, no Supabase, no Cloudflare: everything
# runs in throwaway containers on a private docker network.
#
#   1. Postgres 17 (Aurora's major) with wal_level=logical, wal2json, TLS on and
#      password logins only over TLS; the Aurora baseline the setup assumes
#      (anon/authenticated/service_role, auth.uid(), a stub rds_replication).
#   2. scripts/aws/aurora-realtime-setup.sql applied UNCHANGED except its
#      "-- @tables" lines (the 33 production tables), replaced by one probe
#      table with RLS; realtime_admin is a NON-superuser, like on Aurora.
#      Its password is set as a SCRAM verifier by scripts/aws/scram_verifier.py.
#   3. The image built from services/realtime-aurora/Dockerfile (pinned
#      supabase/realtime + Vitana seeds.exs) with the production env shape.
#   4. Checks: /healthcheck; the management API rejects a member-secret token
#      and accepts the separate API secret; a @supabase/realtime-js client
#      (Host: realtime.vitanaland.com, member JWT) receives an RLS-filtered
#      INSERT, an UPDATE with the old row, a broadcast and presence; after a
#      container restart (seeds upsert path) INSERT delivery still works.
#
# Usage: bash services/realtime-aurora/test/local-delivery.sh   (npm run test:realtime-local)
# Env: PG_IMAGE (default postgres:17), REALTIME_JS_VERSION (default 2.80.0,
#      the gateway lockfile's), PORT (default 14000), KEEP=1 keeps containers.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SVC="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$SVC/../.." && pwd)"
SETUP_SQL="$ROOT/scripts/aws/aurora-realtime-setup.sql"
PG_IMAGE=${PG_IMAGE:-postgres:17}
RTJS=${REALTIME_JS_VERSION:-2.80.0}
PORT=${PORT:-14000}
RT_HOST=realtime.vitanaland.com
ID=$$
NET=rtnet-$ID; PG=rtpg-$ID; RT=rtsrv-$ID
T=$(mktemp -d)

cleanup() {
  local rc=$?
  if [ "$rc" != 0 ]; then
    echo "---- realtime logs (last 80 lines) ----"; docker logs --tail 80 "$RT" 2>&1 || true
    echo "---- postgres logs (last 30 lines) ----"; docker logs --tail 30 "$PG" 2>&1 || true
  fi
  if [ "${KEEP:-0}" != 1 ]; then
    docker rm -f "$RT" "$PG" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    docker rmi -f "rt-aurora-test-$ID" "rt-pg-test-$ID" >/dev/null 2>&1 || true
  fi
  rm -rf "$T"
  exit "$rc"
}
trap cleanup EXIT
step() { echo "== $*"; }
rand() { python3 -Ic "import secrets, string; print(''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range($1)))"; }

# Behind a TLS-intercepting egress proxy (CI does not have one) image builds
# need host networking and the proxy's CA.
BUILD_NET=(); EXTRA_CA=""
if [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]; then
  P="${HTTPS_PROXY:-${https_proxy:-}}"
  BUILD_NET=(--network host --build-arg "https_proxy=$P" --build-arg "HTTPS_PROXY=$P")
  EXTRA_CA="${TEST_EXTRA_CA:-${SSL_CERT_FILE:-}}"
fi

pull_or_mirror() { # image
  docker image inspect "$1" >/dev/null 2>&1 && return 0
  docker pull -q "$1" >/dev/null 2>&1 && return 0
  case "$1" in */*) return 1 ;; esac
  echo "   docker.io pull of $1 failed (rate limit?), trying mirror.gcr.io/library/$1"
  docker pull -q "mirror.gcr.io/library/$1" >/dev/null && docker tag "mirror.gcr.io/library/$1" "$1"
}

step "test secrets (random, this run only)"
TENANT_JWT_SECRET=$(rand 48); API_JWT_SECRET=$(rand 48); METRICS_JWT_SECRET=$(rand 48)
DB_ENC_KEY=$(rand 16); SECRET_KEY_BASE=$(rand 64); RT_PW=$(rand 40)
USER_A=$(python3 -c 'import uuid; print(uuid.uuid4())'); USER_B=$(python3 -c 'import uuid; print(uuid.uuid4())')

step "build the Postgres stand-in ($PG_IMAGE + wal2json, TLS-only password logins)"
pull_or_mirror "$PG_IMAGE"
mkdir -p "$T/pg"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/pg/server.key" -out "$T/pg/server.crt" -days 1 -subj "/CN=$PG" 2>/dev/null
cat > "$T/pg/pg_hba.conf" <<'EOF'
local     all  all                trust
hostssl   all  all  0.0.0.0/0     scram-sha-256
hostssl   all  all  ::/0          scram-sha-256
host      all  all  0.0.0.0/0     reject
host      all  all  ::/0          reject
EOF
if [ -n "$EXTRA_CA" ] && [ -s "$EXTRA_CA" ]; then cp "$EXTRA_CA" "$T/pg/extra-ca.crt"; else : > "$T/pg/extra-ca.crt"; fi
cp "$HERE/pg.Dockerfile" "$T/pg/Dockerfile"
docker build -q "${BUILD_NET[@]}" --build-arg "PG_IMAGE=$PG_IMAGE" -t "rt-pg-test-$ID" "$T/pg" >/dev/null

step "build the Realtime image from services/realtime-aurora"
docker build -q -t "rt-aurora-test-$ID" "$SVC" >/dev/null

# Newer PostgreSQL minors restrict non-superuser output plugins to
# output_plugin_libraries; allow wal2json where the parameter exists.
OPL=()
PG_GUCS=$(docker run --rm "rt-pg-test-$ID" postgres --describe-config 2>/dev/null || true)
if grep -q '^output_plugin_libraries' <<<"$PG_GUCS"; then
  OPL=(-c 'output_plugin_libraries=pgoutput, test_decoding, wal2json')
fi
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" --network-alias aurora.local \
  -e POSTGRES_PASSWORD="$(rand 24)" -e POSTGRES_DB=vitana \
  "rt-pg-test-$ID" \
  -c wal_level=logical -c max_replication_slots=10 -c max_wal_senders=10 \
  "${OPL[@]}" \
  -c ssl=on -c ssl_cert_file=/etc/pg-test/server.crt -c ssl_key_file=/etc/pg-test/server.key \
  -c hba_file=/etc/pg-test/pg_hba.conf -c password_encryption=scram-sha-256 >/dev/null
for _ in $(seq 1 60); do
  docker exec "$PG" pg_isready -U postgres -d vitana -h /var/run/postgresql >/dev/null 2>&1 \
    && docker exec "$PG" psql -U postgres -d vitana -Atqc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
psql_master() { docker exec -i "$PG" psql -U postgres -d vitana -v ON_ERROR_STOP=1 -Atq "$@"; }

step "Aurora baseline: API roles, auth.uid(), stub rds_replication, probe table with RLS"
psql_master <<'EOF'
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role rds_replication nologin;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
create function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create table public.realtime_probe (id bigserial primary key, user_id uuid not null, body text not null,
  created_at timestamptz not null default now());
alter table public.realtime_probe enable row level security;
create policy own_rows on public.realtime_probe for select to authenticated using (user_id = auth.uid());
grant select on public.realtime_probe to authenticated;
EOF

step "scripts/aws/aurora-realtime-setup.sql (all but the @tables lines), as the master user"
grep -v -- '-- @tables$' "$SETUP_SQL" > "$T/setup-local.sql"
N=$(grep -cvE '^(--|$)' "$T/setup-local.sql")
psql_master < "$T/setup-local.sql"
echo "   applied $N statements"
# What GRANT rds_replication confers on Aurora; a plain Postgres stub role cannot.
psql_master -c 'alter role realtime_admin replication'
psql_master <<'EOF'
create publication supabase_realtime for table public.realtime_probe;
alter table public.realtime_probe replica identity full;
EOF
# Re-run: the file must be idempotent.
psql_master < "$T/setup-local.sql"
echo "   re-applied (idempotent)"
step "the production @tables part, in a scratch database with the 33 table names"
docker exec "$PG" psql -U postgres -d vitana -v ON_ERROR_STOP=1 -Atqc 'create database pubcheck' >/dev/null
TABLES=$(grep -E '^ALTER PUBLICATION supabase_realtime SET TABLE ' "$SETUP_SQL" | grep -oE 'SET TABLE [^;]+' | sed 's/^SET TABLE //; s/public\.//g; s/, /\n/g')
[ "$(echo "$TABLES" | wc -l)" = 33 ] || { echo "FAIL setup SQL publishes $(echo "$TABLES" | wc -l) tables, want 33"; exit 1; }
for t in $TABLES; do echo "create table public.$t (id bigint primary key, v text);"; done \
  | docker exec -i "$PG" psql -U postgres -d pubcheck -v ON_ERROR_STOP=1 -Atq
grep -- '-- @tables$' "$SETUP_SQL" > "$T/tables.sql"
docker exec -i "$PG" psql -U postgres -d pubcheck -v ON_ERROR_STOP=1 -Atq < "$T/tables.sql"
docker exec -i "$PG" psql -U postgres -d pubcheck -v ON_ERROR_STOP=1 -Atq < "$T/tables.sql"
echo "PASS 33-table publication + replica identities applied twice, verify block green"
docker exec "$PG" psql -U postgres -d pubcheck -Atqc 'alter table public.chat_groups drop constraint chat_groups_pkey' >/dev/null
if docker exec -i "$PG" psql -U postgres -d pubcheck -v ON_ERROR_STOP=1 -Atq < "$T/tables.sql" >/dev/null 2>"$T/pk.err"; then
  echo "FAIL the primary-key precondition did not stop a DEFAULT-identity table without a key"; exit 1
fi
grep -q 'chat_groups has no primary key' "$T/pk.err" || { echo "FAIL unexpected error: $(cat "$T/pk.err")"; exit 1; }
echo "PASS primary-key precondition refuses chat_groups without a key"
docker exec "$PG" psql -U postgres -d vitana -Atqc 'drop database pubcheck' >/dev/null

VERIFIER=$(printf '%s' "$RT_PW" | python3 -I "$ROOT/scripts/aws/scram_verifier.py")
psql_master -c "alter role realtime_admin with login password '$VERIFIER'"
[ "$(psql_master -c "select rolsuper::text from pg_roles where rolname = 'realtime_admin'")" = false ] \
  || { echo "FAIL realtime_admin must not be a superuser"; exit 1; }

step "start Realtime (production env shape; DB over TLS as non-superuser realtime_admin)"
docker run -d --name "$RT" --network "$NET" -p "127.0.0.1:$PORT:4000" \
  -e DB_HOST=aurora.local -e DB_PORT=5432 -e DB_NAME=vitana -e DB_USER=realtime_admin \
  -e DB_PASSWORD="$RT_PW" -e DB_SSL=true -e TENANT_DB_SSL=true \
  -e DB_AFTER_CONNECT_QUERY='SET search_path TO _realtime' \
  -e DB_ENC_KEY="$DB_ENC_KEY" -e SECRET_KEY_BASE="$SECRET_KEY_BASE" \
  -e API_JWT_SECRET="$API_JWT_SECRET" -e METRICS_JWT_SECRET="$METRICS_JWT_SECRET" \
  -e TENANT_JWT_SECRET="$TENANT_JWT_SECRET" \
  -e RLIMIT_NOFILE="${TEST_RLIMIT_NOFILE:-10000}" -e DNS_NODES="''" -e RUN_JANITOR=true -e DISABLE_HEALTHCHECK_LOGGING=true \
  -e TENANT_MAX_CONCURRENT_USERS=10000 -e TENANT_MAX_EVENTS_PER_SECOND=1000 \
  -e TENANT_MAX_JOINS_PER_SECOND=500 -e TENANT_MAX_CHANNELS_PER_CLIENT=100 -e TENANT_MAX_BYTES_PER_SECOND=1000000 \
  "rt-aurora-test-$ID" >/dev/null
U="http://127.0.0.1:$PORT"
wait_healthy() { # [min "Starting Realtime" count]
  # The seed step (run.sh) boots the whole app, so /healthcheck answers 200
  # while seeds.exs is still running. Wait for run.sh's "Starting Realtime"
  # line (the server proper) first.
  local want=${1:-1}
  for i in $(seq 1 180); do
    [ "$(docker logs "$RT" 2>&1 | grep -c '^Starting Realtime$' || true)" -ge "$want" ] && break
    if [ "$(docker inspect -f '{{.State.Running}}' "$RT")" != true ]; then echo "FAIL realtime container exited during migrations/seeds"; return 1; fi
    sleep 1
  done
  for i in $(seq 1 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$U/healthcheck" || true)" = 200 ] && { echo "   /healthcheck 200 after ${i}s"; return 0; }
    if [ "$(docker inspect -f '{{.State.Running}}' "$RT")" != true ]; then echo "FAIL realtime container exited"; return 1; fi
    sleep 1
  done
  echo "FAIL /healthcheck never returned 200"; return 1
}
wait_healthy

jwt() { # secret, json-claims
  python3 -I - "$1" "$2" <<'PY'
import base64, hashlib, hmac, json, sys, time
secret, claims = sys.argv[1].encode(), json.loads(sys.argv[2])
now = int(time.time()); claims = {"iat": now, "exp": now + 3600, **claims}
b = lambda d: base64.urlsafe_b64encode(json.dumps(d, separators=(",", ":")).encode()).rstrip(b"=")
h, p = b({"alg": "HS256", "typ": "JWT"}), b(claims)
s = base64.urlsafe_b64encode(hmac.new(secret, h + b"." + p, hashlib.sha256).digest()).rstrip(b"=")
print((h + b"." + p + b"." + s).decode())
PY
}
fail=0
check_code() { # name, want, curl args...
  local name=$1 want=$2; shift 2
  local got; got=$(curl -s -o /dev/null -w '%{http_code}' -m 15 "$@" || true)
  if [ "$got" = "$want" ]; then echo "PASS $name ($got)"; else echo "FAIL $name: got $got, want $want"; fail=1; fi
}
ANON=$(jwt "$TENANT_JWT_SECRET" '{"role":"anon","iss":"supabase"}')
SVC_ROLE=$(jwt "$TENANT_JWT_SECRET" '{"role":"service_role","iss":"supabase"}')
ADMIN=$(jwt "$API_JWT_SECRET" '{"role":"realtime_admin"}')
check_code "management API rejects the anon key (member secret)"        403 -H "Authorization: Bearer $ANON" "$U/api/tenants"
check_code "management API rejects a service_role token (member secret)" 403 -H "Authorization: Bearer $SVC_ROLE" "$U/api/tenants"
check_code "management API accepts the separate API secret"               200 -H "Authorization: Bearer $ADMIN" "$U/api/tenants"
check_code "tenant health (API secret) for tenant 'realtime'"             200 -H "Authorization: Bearer $ADMIN" "$U/api/tenants/realtime/health"
check_code "REST broadcast with the anon key via Host $RT_HOST"           202 -H "Host: $RT_HOST" -H "apikey: $ANON" \
  -H "Authorization: Bearer $ANON" -H 'Content-Type: application/json' \
  -d '{"messages":[{"topic":"probe-rest","event":"ping","payload":{"n":1}}]}' "$U/api/broadcast"
FORGED=$(jwt "$(rand 48)" '{"role":"anon","iss":"supabase"}')
ws_code() { # host, token — the same upgrade probe AWS-PROD-DEPLOY-REALTIME-AURORA.yml runs
  curl -s -o /dev/null -w '%{http_code}' -m 4 --http1.1 -H "Host: $1" -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "$U/socket/websocket?apikey=$2&vsn=1.0.0" 2>/dev/null || true
}
check_ws() { # name, want-regex, host, token
  local got; got=$(ws_code "$3" "$4")
  if [[ "$got" =~ ^($2)$ ]]; then echo "PASS $1 ($got)"; else echo "FAIL $1: got $got, want $2"; fail=1; fi
}
check_ws "websocket upgrade, anon key, Host $RT_HOST"          101     "$RT_HOST" "$ANON"
check_ws "websocket upgrade, forged token (other secret)"      '401|403' "$RT_HOST" "$FORGED"
check_ws "websocket upgrade, Host whose first label is not the tenant" 404 other.vitanaland.com "$ANON"
[ "$fail" = 0 ] || exit 1

step "@supabase/realtime-js@$RTJS client"
mkdir -p "$T/client"
( cd "$T/client" && npm init -y >/dev/null && npm install -s --no-audit --no-fund "@supabase/realtime-js@$RTJS" ws@8.18.3 >/dev/null )
cp "$HERE/client.mjs" "$T/client/client.mjs"
run_client() { # mode
  RT_URL="ws://127.0.0.1:$PORT/socket" RT_HOST="$RT_HOST" TENANT_JWT_SECRET="$TENANT_JWT_SECRET" \
  USER_A="$USER_A" USER_B="$USER_B" MODE="$1" \
  PSQL="[\"docker\",\"exec\",\"$PG\",\"psql\",\"-U\",\"postgres\",\"-d\",\"vitana\",\"-v\",\"ON_ERROR_STOP=1\",\"-Atqc\"]" \
  node "$T/client/client.mjs"
}
run_client full

SLOTS=$(psql_master -c "select count(*) from pg_replication_slots where slot_type = 'logical' and plugin = 'wal2json'")
echo "   wal2json logical slots held by Realtime: $SLOTS"

step "restart Realtime (seeds.exs upsert path on an existing tenant), deliver again"
docker restart "$RT" >/dev/null
wait_healthy 2
psql_master -c "delete from public.realtime_probe"
run_client changes
echo "ALL PASS: realtime-aurora local delivery"
