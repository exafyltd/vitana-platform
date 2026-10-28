#!/usr/bin/env bash
# capture-snapshot.sh — capture a black-box snapshot of ONE staging
# environment (gateway + frontend) into a directory of JSON artifacts.
#
# Usage:
#   ./capture-snapshot.sh --label gcp \
#     --gateway https://preview-gateway.vitanaland.com \
#     --frontend https://preview.vitanaland.com \
#     --out ./snapshots/gcp
#
# Everything captured here is auth-free and secret-free (environment
# identity, route mounts, headers, latency, frontend bundle wiring). Run it
# once against the GCP staging stack and once against the AWS staging stack,
# then feed both directories to compare-snapshots.sh.
#
# Requires: bash, curl, jq.

set -euo pipefail

GATEWAY="" FRONTEND="" OUT="" LABEL="env"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway)  GATEWAY="${2%/}"; shift 2 ;;
    --frontend) FRONTEND="${2%/}"; shift 2 ;;
    --out)      OUT="$2"; shift 2 ;;
    --label)    LABEL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done
[[ -n "$GATEWAY" && -n "$OUT" ]] || {
  echo "Usage: $0 --label <name> --gateway <url> [--frontend <url>] --out <dir>" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/route-manifest.json"
[[ -f "$MANIFEST" ]] || { echo "route-manifest.json missing — run generate-route-manifest.mjs first" >&2; exit 2; }

mkdir -p "$OUT"
CURL=(curl -sS --max-time 30)

note() { echo "[$LABEL] $*" >&2; }

# ---------------------------------------------------------------- 1. identity
note "capturing /alive + /api/v1/admin/health + /api/v1/admin/build-info"
"${CURL[@]}" -o "$OUT/alive.body" -w '{"http_code":%{http_code},"content_type":"%{content_type}","time_total":%{time_total}}' \
  "$GATEWAY/alive" > "$OUT/alive.meta.json" || echo '{"http_code":0}' > "$OUT/alive.meta.json"

for ep in health build-info; do
  "${CURL[@]}" -o "$OUT/$ep.body" -w '{"http_code":%{http_code},"content_type":"%{content_type}","time_total":%{time_total}}' \
    "$GATEWAY/api/v1/admin/$ep" > "$OUT/$ep.meta.json" || echo '{"http_code":0}' > "$OUT/$ep.meta.json"
  # Pretty-copy if JSON (jq fails harmlessly on non-JSON bodies).
  jq . "$OUT/$ep.body" > "$OUT/$ep.json" 2>/dev/null || cp "$OUT/$ep.body" "$OUT/$ep.json"
done

# ------------------------------------------------------------- 2. route mounts
# JSON-vs-HTML 404 diagnostic: mounted Express routers answer JSON
# (200/400/401/403/404-with-body); an unmounted path falls through to the
# Express default handler → text/html. This proves the same CODE surface is
# live without any credentials.
note "probing route mounts ($(jq -r .route_count "$MANIFEST") prefixes)"
echo '[' > "$OUT/routes.json.tmp"
first=1
while IFS=$'\t' read -r prefix probe; do
  meta=$("${CURL[@]}" -o /dev/null -w '%{http_code}\t%{content_type}' "$GATEWAY$probe" 2>/dev/null || echo -e "000\t")
  code="${meta%%$'\t'*}"; ctype="${meta#*$'\t'}"
  case "$ctype" in
    application/json*) klass="json" ;;
    text/html*)        klass="html" ;;
    "")                klass="none" ;;
    *)                 klass="other" ;;
  esac
  # Route considered MOUNTED when the answer is JSON, or any non-404 status
  # (e.g. redirects, SSE, static 200s).
  if [[ "$klass" == "json" || ( "$code" != "404" && "$code" != "000" ) ]]; then
    mounted=true
  else
    mounted=false
  fi
  [[ $first -eq 1 ]] || echo ',' >> "$OUT/routes.json.tmp"
  first=0
  jq -nc --arg p "$prefix" --arg c "$code" --arg t "$ctype" --argjson m "$mounted" \
    '{prefix:$p, http_code:($c|tonumber), content_type:$t, mounted:$m}' >> "$OUT/routes.json.tmp"
done < <(jq -r '.routes[] | [.prefix, .probe_path] | @tsv' "$MANIFEST")
echo ']' >> "$OUT/routes.json.tmp"
jq . "$OUT/routes.json.tmp" > "$OUT/routes.json" && rm "$OUT/routes.json.tmp"

# ----------------------------------------------------------- 3. headers + CORS
note "capturing response headers + CORS preflight"
"${CURL[@]}" -D - -o /dev/null "$GATEWAY/api/v1/admin/health" \
  | tr -d '\r' | grep -iE '^(server|via|x-|strict-transport|content-security|access-control|cache-control):' \
  | sort -f > "$OUT/gateway-headers.txt" || true

"${CURL[@]}" -o /dev/null -D - -X OPTIONS "$GATEWAY/api/v1/admin/health" \
  -H "Origin: ${FRONTEND:-https://preview.vitanaland.com}" \
  -H "Access-Control-Request-Method: GET" \
  | tr -d '\r' | grep -iE '^(HTTP/|access-control)' > "$OUT/cors-preflight.txt" || true

# ---------------------------------------------------------------- 4. latency
note "sampling latency (5x /api/v1/admin/health)"
for i in 1 2 3 4 5; do
  "${CURL[@]}" -o /dev/null -w '%{time_total}\n' "$GATEWAY/api/v1/admin/health" || echo "-1"
done > "$OUT/latency-samples.txt"

# ------------------------------------------------------ 5. websocket upgrade
# ORB voice rides a WebSocket. We can't complete a handshake without auth,
# but the transport layer must at least SPEAK WebSocket: a load balancer that
# strips Upgrade headers answers with a plain 200/502 instead of 4xx-from-app
# or 101. Record what comes back for the comparison.
note "probing WebSocket upgrade behavior"
ws_meta=$("${CURL[@]}" -o /dev/null -w '%{http_code}\t%{content_type}' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  "$GATEWAY/api/v1/orb/live" 2>/dev/null || echo -e "000\t")
jq -nc --arg c "${ws_meta%%$'\t'*}" --arg t "${ws_meta#*$'\t'}" \
  '{http_code:($c|tonumber), content_type:$t}' > "$OUT/websocket-probe.json"

# ---------------------------------------------------------------- 6. frontend
if [[ -n "$FRONTEND" ]]; then
  note "capturing frontend index.html + baked bundle wiring"
  "${CURL[@]}" -o "$OUT/frontend-index.html" \
    -w '{"http_code":%{http_code},"content_type":"%{content_type}","time_total":%{time_total}}' \
    "$FRONTEND/" > "$OUT/frontend.meta.json" || echo '{"http_code":0}' > "$OUT/frontend.meta.json"

  # SPA fallback: a deep route must serve index.html (200), not 404 —
  # this is the check that catches a mis-configured AWS static host/CDN.
  spa=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$FRONTEND/settings" || echo "000")
  jq -nc --arg c "$spa" '{deep_route_http_code:($c|tonumber)}' > "$OUT/frontend-spa-fallback.json"

  # Extract the fingerprinted JS entry bundle and grep out the baked-in
  # gateway + Supabase URLs. THE critical frontend check: the AWS frontend
  # must point at the AWS gateway, and both frontends must share the SAME
  # Supabase project (auth tokens must verify on the gateway).
  bundle=$(grep -oE 'src="[^"]+\.js"' "$OUT/frontend-index.html" | head -1 | sed 's/src="//;s/"//' || true)
  if [[ -n "${bundle:-}" ]]; then
    [[ "$bundle" == /* ]] && bundle_url="$FRONTEND$bundle" || bundle_url="$bundle"
    "${CURL[@]}" -o "$OUT/frontend-bundle.js" "$bundle_url" || true
    all_urls=$(grep -oE 'https?://[A-Za-z0-9._:-]+' "$OUT/frontend-bundle.js" 2>/dev/null | sort -u | jq -R . | jq -s . || echo '[]')
    [[ -n "$all_urls" ]] || all_urls='[]'
    jq -n --arg bundle "$bundle" --argjson urls "$all_urls" \
      '{bundle:$bundle, urls:$urls, supabase_urls:[$urls[] | select(test("supabase\\.co"))]}' \
      > "$OUT/frontend-wiring.json"
    rm -f "$OUT/frontend-bundle.js"   # big; wiring extract is what we keep
  else
    jq -n '{bundle:null, urls:[], supabase_urls:[]}' > "$OUT/frontend-wiring.json"
  fi
fi

# ---------------------------------------------------------------- 7. summary
jq -n \
  --arg label "$LABEL" \
  --arg gateway "$GATEWAY" \
  --arg frontend "${FRONTEND:-}" \
  --arg captured_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --slurpfile health "$OUT/health.meta.json" \
  '{label:$label, gateway:$gateway, frontend:$frontend, captured_at:$captured_at, health_meta:$health[0]}' \
  > "$OUT/snapshot.json"

note "snapshot written to $OUT"
