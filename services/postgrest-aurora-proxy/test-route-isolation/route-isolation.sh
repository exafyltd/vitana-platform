#!/usr/bin/env bash
# Behavior checks for the PostgREST-Aurora proxy route profiles (route isolation, cases B1 to B6).
#
# Builds the production profile (default build) and the staging profile (PROXY_TEMPLATE=nginx.staging.conf.template),
# starts a mock Supabase on a Docker network under the reserved name mock-supabase.invalid, and sends real HTTP requests
# to the proxy images. Output: one line per check, "CASE <B-id> PASS <detail>" or "CASE <B-id> FAIL <detail>".
# Exit status 1 when any check fails. Needs a reachable Docker daemon and openssl. Nothing is skipped: a case that
# cannot run is reported as FAIL with the reason. The mock is the only upstream. The run stops when the mock is not
# running, and a SUPABASE_AUTH_HOST value other than the mock (or 127.0.0.1) is refused.
#   bash services/postgrest-aurora-proxy/test-route-isolation/route-isolation.sh
set -uo pipefail

PROXY_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# The local mock is the only Supabase auth host this harness uses. The name ends in .invalid, a name RFC 2606 reserves,
# so no public resolver answers it. Keep production Supabase project refs out of this file.
MOCK_AUTH_HOST=mock-supabase.invalid
AUTH_HOST=$MOCK_AUTH_HOST
PUBLIC_HOST=data.vitanaland.com
STAGING_TEMPLATE=nginx.staging.conf.template
RUN_ID="$$"
WORK="$(mktemp -d)"
NET="pgproxy-route-net-$RUN_ID"
MOCK="pgproxy-route-mock-$RUN_ID"
IMG_PROD="pgproxy-route-prod-$RUN_ID"
IMG_STAGING="pgproxy-route-staging-$RUN_ID"
CONTAINERS=()
FAILS=0
PORT=""
CAND_PORT=""
CAND_SET_PORT=""
R_STATUS=""
R_TYPE=""
R_BODY=""

pass() { printf 'CASE %s PASS %s\n' "$1" "$2"; }
fail() { printf 'CASE %s FAIL %s\n' "$1" "$2"; FAILS=$((FAILS + 1)); }

cleanup() {
  local c
  for c in "${CONTAINERS[@]}" "$MOCK"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rmi -f "$IMG_PROD" "$IMG_STAGING" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Stops the run. Every case reports the same reason, so no case can pass by accident.
abort() {
  local id
  for id in B1 B2 B3 B4 B5 B6; do fail "$id" "run stopped: $1"; done
  exit 1
}

# Fails closed when the mock Supabase is not running. It is the only upstream the production profile may reach, so no
# proxy starts and no request is sent while it is down.
require_mock() {
  if [ "$(docker inspect -f '{{.State.Running}}' "$MOCK" 2>/dev/null)" != true ]; then
    abort "the local mock Supabase is not running"
  fi
}

# Refuses a SUPABASE_AUTH_HOST value other than the local mock. The loopback value is the one other value a case uses
# (B4). Nothing listens there inside the proxy container, so it cannot reach a Supabase host.
check_auth_host() {
  case "$1" in
    "$MOCK_AUTH_HOST" | 127.0.0.1) ;;
    *) abort "refusing a SUPABASE_AUTH_HOST value that is not the local mock" ;;
  esac
}

# Starts a proxy container from IMAGE with optional docker run options, and waits until /alive answers.
# Sets PORT to the host port. Returns 1 when the container does not come up.
start_proxy() {
  local name=$1 image=$2 arg
  shift 2
  require_mock
  for arg in "$@"; do
    case "$arg" in
      SUPABASE_AUTH_HOST=*) check_auth_host "${arg#SUPABASE_AUTH_HOST=}" ;;
    esac
  done
  CONTAINERS+=("$name")
  docker run -d --name "$name" --network "$NET" -p 127.0.0.1::8080 "$@" "$image" >/dev/null 2>&1 || return 1
  PORT=$(docker port "$name" 8080 2>/dev/null | head -n 1)
  PORT=${PORT##*:}
  local i
  for i in $(seq 1 60); do
    if curl -s -m 2 -o /dev/null "http://127.0.0.1:$PORT/alive" 2>/dev/null; then return 0; fi
    [ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" = true ] || return 1
    sleep 0.5
  done
  return 1
}

stop_proxy() { docker rm -f "$1" >/dev/null 2>&1 || true; }

# Sends one request to 127.0.0.1:PORT with the path as written. Sets R_STATUS, R_TYPE (Content-Type) and R_BODY.
req() {
  local port=$1 path=$2
  shift 2
  require_mock
  local out="$WORK/resp.$RANDOM$RANDOM" meta
  meta=$(curl -s -m 30 --path-as-is -o "$out" -w '%{http_code} %{content_type}' "$@" "http://127.0.0.1:${port}${path}" 2>/dev/null) || meta="000 "
  R_STATUS=${meta%% *}
  R_TYPE=${meta#* }
  R_BODY=$(head -c 300 "$out" 2>/dev/null | tr '\n' ' ')
  rm -f "$out"
}

# Requests that the mock Supabase has received. A short wait lets nginx write the access log line first.
mock_count() {
  sleep 0.5
  docker logs "$MOCK" 2>&1 | grep -c '^UPSTREAM ' || true
}

# True when the last path segment has no file extension. nginx may choose a Content-Type from an extension.
ext_free() {
  local p=${1%%\?*}
  local seg=${p##*/}
  [[ "$seg" != *.* ]]
}

# probe403 LABEL PORT PATH [curl options...]: the staging gate must answer 403 forbidden_route, and the mock sees nothing.
probe403() {
  local label=$1 port=$2 path=$3
  shift 3
  local before after problems=""
  before=$(mock_count)
  req "$port" "$path" "$@"
  after=$(mock_count)
  [ "$R_STATUS" = 403 ] || problems="$problems status=$R_STATUS;"
  case "$R_BODY" in *forbidden_route*) ;; *) problems="$problems body=${R_BODY:0:80};" ;; esac
  [ "$before" = "$after" ] || problems="$problems upstream_requests=$before->$after;"
  if ext_free "$path" && [ "$R_TYPE" != application/json ]; then problems="$problems content_type=$R_TYPE;"; fi
  if [ -z "$problems" ]; then pass B2 "$label: 403 forbidden_route, no upstream request"; else fail B2 "$label: $problems"; fi
}

# B2: every production-bound probe, against the staging image with SUPABASE_AUTH_HOST unset and set.
run_b2() {
  local tag=$1 port=$2 k1="$WORK/k1.bin"
  head -c 1024 /dev/zero > "$k1"
  probe403 "$tag GET /auth/v1/health" "$port" /auth/v1/health
  probe403 "$tag POST /auth/v1/token (1 KB)" "$port" "/auth/v1/token?grant_type=password" -X POST -H 'Content-Type: application/json' --data-binary "@$k1"
  probe403 "$tag GET /auth/v1/user" "$port" /auth/v1/user
  probe403 "$tag GET /auth/v1" "$port" /auth/v1
  probe403 "$tag GET //auth/v1/health" "$port" //auth/v1/health
  probe403 "$tag GET /%61uth/v1/health" "$port" /%61uth/v1/health
  probe403 "$tag GET /rest/v1/../../auth/v1/health" "$port" /rest/v1/../../auth/v1/health
  probe403 "$tag GET /AUTH/v1/health" "$port" /AUTH/v1/health
  probe403 "$tag GET /storage/v1/object/public/a/b.png" "$port" /storage/v1/object/public/a/b.png
  probe403 "$tag POST /storage/v1/object/b/a.bin (1 KB)" "$port" /storage/v1/object/b/a.bin -X POST --data-binary "@$k1"
  probe403 "$tag GET /storage/v1" "$port" /storage/v1
  probe403 "$tag POST /functions/v1/ai-chat?x=1 (1 KB)" "$port" "/functions/v1/ai-chat?x=1" -X POST --data-binary "@$k1"
  probe403 "$tag GET /functions/v1/x" "$port" /functions/v1/x
  probe403 "$tag GET /functions/v1" "$port" /functions/v1
  probe403 "$tag GET /realtime/v1/websocket (Upgrade)" "$port" "/realtime/v1/websocket?vsn=1.0.0" -H 'Connection: Upgrade' -H 'Upgrade: websocket'
  probe403 "$tag GET /realtime/v1/" "$port" /realtime/v1/
}

# B1: the production profile with SUPABASE_AUTH_HOST set forwards /auth/v1 to the mock, with the auth host as Host.
b1() {
  local before after problems="" mock_logs
  if ! start_proxy "b1-$RUN_ID" "$IMG_PROD" -e "SUPABASE_AUTH_HOST=$AUTH_HOST"; then
    fail B1 "production profile with SUPABASE_AUTH_HOST did not start"
    return
  fi
  before=$(mock_count)
  req "$PORT" /auth/v1/health
  after=$(mock_count)
  [ "$R_STATUS" = 200 ] || problems="$problems status=$R_STATUS;"
  [[ "$R_BODY" == "upstream ok"* ]] || problems="$problems body=${R_BODY:0:80};"
  [ "$after" = $((before + 1)) ] || problems="$problems upstream_requests=$before->$after;"
  mock_logs=$(docker logs "$MOCK" 2>&1)
  grep -q "^UPSTREAM /auth/v1/health host=$AUTH_HOST" <<< "$mock_logs" || problems="$problems no mock line with host=$AUTH_HOST;"
  if [ -z "$problems" ]; then pass B1 "production profile forwards /auth/v1/health to the mock (200, one upstream request)"; else fail B1 "$problems"; fi
  stop_proxy "b1-$RUN_ID"
}

# B3: the staging image forwards nothing and answers its authorized routes. No PostgREST sidecar runs here, so the
# /rest calls must end at the postgrest_local upstream (502), which proves they reached it.
b3() {
  local before after problems=""
  before=$(mock_count)
  req "$CAND_PORT" /alive
  [ "$R_STATUS" = 200 ] && [[ "$R_BODY" == ok* ]] || problems="$problems alive=$R_STATUS;"
  req "$CAND_PORT" /rest/v1/profiles
  [ "$R_STATUS" = 502 ] || problems="$problems rest=$R_STATUS;"
  req "$CAND_PORT" /rest/v1/rpc/fn
  [ "$R_STATUS" = 502 ] || problems="$problems rpc=$R_STATUS;"
  req "$CAND_PORT" /nope
  [ "$R_STATUS" = 501 ] && [[ "$R_BODY" == *not_implemented* ]] || problems="$problems default=$R_STATUS;"
  req "$CAND_PORT" /alive -H "Host: $PUBLIC_HOST"
  [ "$R_STATUS" = 200 ] || problems="$problems public_alive=$R_STATUS;"
  req "$CAND_PORT" /rest/v1/profiles -H "Host: $PUBLIC_HOST"
  [ "$R_STATUS" = 502 ] || problems="$problems public_rest=$R_STATUS;"
  req "$CAND_PORT" /auth/v1/token -H "Host: $PUBLIC_HOST"
  [ "$R_STATUS" = 404 ] || problems="$problems public_auth=$R_STATUS;"
  after=$(mock_count)
  [ "$before" = "$after" ] || problems="$problems upstream_requests=$before->$after;"
  if [ -z "$problems" ]; then
    pass B3 "staging image: /alive 200, /rest reaches postgrest_local (502), /nope 501, public /auth 404, no upstream request"
  else
    fail B3 "$problems"
  fi
}

# B4: rollback drill. Candidate, production profile with the mock, production profile with 127.0.0.1, candidate again.
b4() {
  local before after problems=""
  if start_proxy "b4a-$RUN_ID" "$IMG_STAGING"; then
    req "$PORT" /auth/v1/health
    [ "$R_STATUS" = 403 ] || problems="$problems candidate=$R_STATUS;"
  else
    problems="$problems candidate=did-not-start;"
  fi
  stop_proxy "b4a-$RUN_ID"

  if start_proxy "b4b-$RUN_ID" "$IMG_PROD" -e "SUPABASE_AUTH_HOST=$AUTH_HOST"; then
    before=$(mock_count)
    req "$PORT" /auth/v1/health
    after=$(mock_count)
    [ "$R_STATUS" = 200 ] || problems="$problems alias=$R_STATUS;"
    [ "$after" = $((before + 1)) ] || problems="$problems alias_upstream=$before->$after;"
  else
    problems="$problems alias=did-not-start;"
  fi
  stop_proxy "b4b-$RUN_ID"

  if start_proxy "b4c-$RUN_ID" "$IMG_PROD" -e "SUPABASE_AUTH_HOST=127.0.0.1"; then
    before=$(mock_count)
    req "$PORT" /auth/v1/health
    after=$(mock_count)
    [ "$R_STATUS" = 502 ] || problems="$problems loopback=$R_STATUS;"
    [ "$before" = "$after" ] || problems="$problems loopback_upstream=$before->$after;"
  else
    problems="$problems loopback=did-not-start;"
  fi
  stop_proxy "b4c-$RUN_ID"

  if start_proxy "b4d-$RUN_ID" "$IMG_STAGING"; then
    req "$PORT" /auth/v1/health
    [ "$R_STATUS" = 403 ] || problems="$problems candidate_again=$R_STATUS;"
  else
    problems="$problems candidate_again=did-not-start;"
  fi
  stop_proxy "b4d-$RUN_ID"

  if [ -z "$problems" ]; then
    pass B4 "rollback drill: candidate 403, production+alias 200 via mock, production+127.0.0.1 502 with no mock request, candidate 403"
  else
    fail B4 "$problems"
  fi
}

# B5: startup and health. The staging image starts with SUPABASE_AUTH_HOST unset, and the production image starts
# with it set (it cannot start without it, see B6). Both answer /alive with 200.
b5() {
  local problems=""
  req "$CAND_PORT" /alive
  [ "$R_STATUS" = 200 ] || problems="$problems staging_unset_alive=$R_STATUS;"
  if start_proxy "b5-$RUN_ID" "$IMG_PROD" -e "SUPABASE_AUTH_HOST=$AUTH_HOST"; then
    req "$PORT" /alive
    [ "$R_STATUS" = 200 ] || problems="$problems production_alive=$R_STATUS;"
  else
    problems="$problems production=did-not-start;"
  fi
  stop_proxy "b5-$RUN_ID"
  if [ -z "$problems" ]; then pass B5 "/alive 200 on the staging image (variable unset) and on the production image (variable set)"; else fail B5 "$problems"; fi
}

# B6: pairing. The production image with SUPABASE_AUTH_HOST unset renders an upstream without a host and exits.
b6() {
  local name="b6-$RUN_ID" i state="" code=""
  require_mock
  CONTAINERS+=("$name")
  if ! docker run -d --name "$name" --network "$NET" "$IMG_PROD" >/dev/null 2>&1; then
    fail B6 "production image could not be started"
    return
  fi
  for i in $(seq 1 30); do
    state=$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null)
    [ "$state" = exited ] && break
    sleep 0.5
  done
  code=$(docker inspect -f '{{.State.ExitCode}}' "$name" 2>/dev/null)
  if [ "$state" = exited ] && [ -n "$code" ] && [ "$code" != 0 ]; then
    pass B6 "production image without SUPABASE_AUTH_HOST exits with code $code (never pair it with the staging definition)"
  else
    fail B6 "state=$state exit_code=$code"
  fi
  stop_proxy "$name"
}

# ---- setup
case "$MOCK_AUTH_HOST" in
  *.invalid) ;;
  *) abort "the mock auth host must be a reserved .invalid name" ;;
esac
command -v docker >/dev/null 2>&1 || abort "docker is not installed"
docker info >/dev/null 2>&1 || abort "the Docker daemon is not reachable"
command -v curl >/dev/null 2>&1 || abort "curl is not installed"
command -v openssl >/dev/null 2>&1 || abort "openssl is not installed"

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/k.pem" -out "$WORK/c.pem" -days 1 \
  -subj "/CN=$AUTH_HOST" >/dev/null 2>&1 || abort "the mock certificate could not be created"
cat > "$WORK/mock.conf" <<'EOF'
events {}
http {
    log_format upstream 'UPSTREAM $request_uri host=$host upgrade=$http_upgrade';
    access_log /dev/stdout upstream;
    server {
        listen 443 ssl;
        ssl_certificate /etc/nginx/mock/c.pem;
        ssl_certificate_key /etc/nginx/mock/k.pem;
        location / {
            default_type text/plain;
            return 200 "upstream ok\n";
        }
    }
}
EOF
chmod 644 "$WORK"/*
docker build -q -t "$IMG_PROD" "$PROXY_DIR" >/dev/null 2>&1 || abort "docker build of the production profile failed"
docker build -q --build-arg "PROXY_TEMPLATE=$STAGING_TEMPLATE" -t "$IMG_STAGING" "$PROXY_DIR" >/dev/null 2>&1 \
  || abort "docker build of the staging profile failed"
docker network create "$NET" >/dev/null 2>&1 || abort "the Docker network could not be created"
docker run -d --name "$MOCK" --network "$NET" --network-alias "$AUTH_HOST" \
  -v "$WORK/mock.conf:/etc/nginx/nginx.conf:ro" \
  -v "$WORK/c.pem:/etc/nginx/mock/c.pem:ro" \
  -v "$WORK/k.pem:/etc/nginx/mock/k.pem:ro" \
  nginx:1.27-alpine >/dev/null 2>&1 || abort "the mock Supabase container did not start"
sleep 1
require_mock

start_proxy "cand-unset-$RUN_ID" "$IMG_STAGING" && CAND_PORT=$PORT
start_proxy "cand-set-$RUN_ID" "$IMG_STAGING" -e "SUPABASE_AUTH_HOST=$AUTH_HOST" && CAND_SET_PORT=$PORT

# ---- cases
b1
if [ -n "$CAND_PORT" ]; then
  run_b2 "unset:" "$CAND_PORT"
  b3
  b5
else
  for id in B2 B3 B5; do fail "$id" "staging image (SUPABASE_AUTH_HOST unset) did not start"; done
fi
if [ -n "$CAND_SET_PORT" ]; then
  run_b2 "set:" "$CAND_SET_PORT"
else
  fail B2 "staging image (SUPABASE_AUTH_HOST set) did not start"
fi
b4
b6

if [ "$FAILS" -eq 0 ]; then
  exit 0
fi
exit 1
