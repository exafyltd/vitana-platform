#!/usr/bin/env bash
# Routing test for the PostgREST-Aurora proxy's nginx config (VTID-05023).
# Builds the proxy image and runs it against a mock HTTPS "Supabase" (an nginx
# that echoes the request back) on a private docker network. No AWS, no real
# Supabase. Proves: /auth, /storage, /functions and /realtime (with the
# WebSocket upgrade) reach Supabase with the right Host, large storage uploads
# pass, functions keep their 50 MB cap, unknown paths answer 501, and /rest
# goes to the local PostgREST upstream (502 here: no sidecar in this test).
# Usage: bash services/postgrest-aurora-proxy/test/routing.sh
set -euo pipefail
cd "$(dirname "$0")/.."
H=inmkhvwdcuyhnxkgfvsb.supabase.co
T=$(mktemp -d); NET=pxnet-$$; PORT=${PORT:-18080}
cleanup() { docker rm -f "mock-$$" "px-$$" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/k.pem" -out "$T/c.pem" -days 1 -subj "/CN=$H" 2>/dev/null
cat > "$T/mock.conf" <<'EOF'
events {}
http { client_max_body_size 0; server { listen 443 ssl; ssl_certificate /c.pem; ssl_certificate_key /k.pem;
  location / { default_type text/plain; return 200 "UPSTREAM uri=$request_uri host=$host upgrade=$http_upgrade len=$content_length\n"; } } }
EOF
chmod 644 "$T"/*
docker build -q -t "pgproxy-routing-$$" . >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name "mock-$$" --network "$NET" --network-alias "$H" \
  -v "$T/mock.conf:/etc/nginx/nginx.conf:ro" -v "$T/c.pem:/c.pem:ro" -v "$T/k.pem:/k.pem:ro" nginx:1.27-alpine >/dev/null
docker run -d --name "px-$$" --network "$NET" -p "127.0.0.1:$PORT:8080" -e SUPABASE_AUTH_HOST="$H" "pgproxy-routing-$$" >/dev/null
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/alive" >/dev/null && break; sleep 1; done

fail=0
check() { # name, expected substring, curl args...
  local name=$1 want=$2; shift 2
  local got; got=$(curl -s -m 30 "$@" || true)
  if [[ "$got" == *"$want"* ]]; then echo "PASS $name"; else echo "FAIL $name: got ${got:0:200}"; fail=1; fi
}
U="http://127.0.0.1:$PORT"
check "auth passthrough"      "uri=/auth/v1/health host=$H"                            "$U/auth/v1/health"
check "storage passthrough"   "uri=/storage/v1/object/public/a/b.png host=$H"          "$U/storage/v1/object/public/a/b.png"
check "functions passthrough" "uri=/functions/v1/ai-chat?x=1 host=$H"                  "$U/functions/v1/ai-chat?x=1"
check "realtime websocket"    "uri=/realtime/v1/websocket?vsn=1.0.0 host=$H upgrade=websocket" \
      -H "Connection: Upgrade" -H "Upgrade: websocket" "$U/realtime/v1/websocket?vsn=1.0.0"
check "storage 30MB upload"   "len=31457280" -X POST --data-binary @<(head -c 31457280 /dev/zero) "$U/storage/v1/object/b/big.bin"
check "functions 50MB cap"    "413" -o /dev/null -w "%{http_code}" -X POST --data-binary @<(head -c 60000000 /dev/zero) "$U/functions/v1/x"
check "rest goes to PostgREST" "502" -o /dev/null -w "%{http_code}" "$U/rest/v1/profiles"
check "unknown path 501"      "not_implemented" "$U/nope"
docker rmi -f "pgproxy-routing-$$" >/dev/null 2>&1 || true
exit $fail
