#!/usr/bin/env bash
# compare-snapshots.sh — diff two environment snapshots (GCP staging vs AWS
# staging) captured by capture-snapshot.sh, and emit a PASS/FAIL/WARN parity
# report (markdown on stdout; exit 1 when any FAIL).
#
# Usage:
#   ./compare-snapshots.sh ./snapshots/gcp ./snapshots/aws [report.md]
#
# Check semantics:
#   FAIL — a contract both environments must satisfy is broken.
#   WARN — a difference that is plausible-but-suspicious; human judgement.
#   INFO — expected to differ (revision names, latency, hosting headers).

set -uo pipefail

REF_DIR="${1:?usage: compare-snapshots.sh <reference-dir> <candidate-dir> [report.md]}"
CAND_DIR="${2:?usage: compare-snapshots.sh <reference-dir> <candidate-dir> [report.md]}"
REPORT="${3:-/dev/stdout}"

REF_LABEL=$(jq -r '.label // "reference"' "$REF_DIR/snapshot.json" 2>/dev/null || echo reference)
CAND_LABEL=$(jq -r '.label // "candidate"' "$CAND_DIR/snapshot.json" 2>/dev/null || echo candidate)

FAILS=0 WARNS=0
ROWS=""

row() { # status | check | detail
  local st="$1" check="$2" detail="$3"
  case "$st" in
    FAIL) FAILS=$((FAILS+1)); st="❌ FAIL" ;;
    WARN) WARNS=$((WARNS+1)); st="⚠️ WARN" ;;
    PASS) st="✅ PASS" ;;
    INFO) st="ℹ️ INFO" ;;
  esac
  ROWS+="| $st | $check | $detail |"$'\n'
}

jf() { jq -r "$2 // empty" "$1" 2>/dev/null; }

# ------------------------------------------------------------ 1. reachability
for side in "$REF_DIR:$REF_LABEL" "$CAND_DIR:$CAND_LABEL"; do
  d="${side%%:*}"; l="${side##*:}"
  code=$(jf "$d/health.meta.json" '.http_code')
  if [[ "$code" == "200" ]]; then
    row PASS "$l gateway reachable" "/api/v1/admin/health → 200"
  else
    row FAIL "$l gateway reachable" "/api/v1/admin/health → HTTP ${code:-none}"
  fi
done

# ------------------------------------------------------- 2. environment identity
for side in "$REF_DIR:$REF_LABEL" "$CAND_DIR:$CAND_LABEL"; do
  d="${side%%:*}"; l="${side##*:}"
  env=$(jf "$d/health.json" '.env')
  if [[ "$env" == "staging" ]]; then
    row PASS "$l env identity" "env=staging (VITANA_ENV wired correctly)"
  else
    row FAIL "$l env identity" "env='${env:-<missing>}' — expected 'staging'. VITANA_ENV not set on the service."
  fi
done

# ------------------------------------------------------------ 3. Supabase host
ref_supa=$(jf "$REF_DIR/health.json" '.supabase_host')
cand_supa=$(jf "$CAND_DIR/health.json" '.supabase_host')
if [[ -n "$ref_supa" && "$ref_supa" == "$cand_supa" ]]; then
  row PASS "Supabase alignment" "both gateways use $ref_supa"
elif [[ -z "$cand_supa" ]]; then
  row FAIL "Supabase alignment" "$CAND_LABEL reports no supabase_host — SUPABASE_URL missing/malformed"
else
  row FAIL "Supabase alignment" "$REF_LABEL=$ref_supa vs $CAND_LABEL=$cand_supa — user auth/data will diverge (see BOOTSTRAP-ORB-STAGING-SUPABASE-ALIGN)"
fi

# --------------------------------------------------------------- 4. git commit
ref_commit=$(jf "$REF_DIR/build-info.json" '.git_commit')
cand_commit=$(jf "$CAND_DIR/build-info.json" '.git_commit')
if [[ -n "$ref_commit" && "$ref_commit" == "$cand_commit" ]]; then
  row PASS "Deployed commit" "both serve ${ref_commit:0:12}"
elif [[ -z "$cand_commit" ]]; then
  row WARN "Deployed commit" "$CAND_LABEL reports no git_commit — GIT_COMMIT_SHA/COMMIT_SHA env var not stamped by the AWS deploy pipeline"
else
  row WARN "Deployed commit" "$REF_LABEL=${ref_commit:0:12} vs $CAND_LABEL=${cand_commit:0:12} — environments run different code; redeploy before comparing behavior"
fi

# ---------------------------------------------------------- 5. platform identity
cand_svc=$(jf "$CAND_DIR/health.json" '.cloud_run_service')
row INFO "Platform identity" "$CAND_LABEL cloud_run_service='${cand_svc:-null}' (null is expected off Cloud Run — K_SERVICE/K_REVISION are GCP-injected; set equivalents on AWS if the Command Hub CLOCK view needs them)"

# -------------------------------------------------------------- 6. route mounts
if [[ -f "$REF_DIR/routes.json" && -f "$CAND_DIR/routes.json" ]]; then
  missing=$(jq -n --slurpfile r "$REF_DIR/routes.json" --slurpfile c "$CAND_DIR/routes.json" '
    [ $r[0][] | select(.mounted) | .prefix ] as $ref_mounted
    | [ $c[0][] | select(.mounted) | .prefix ] as $cand_mounted
    | $ref_mounted - $cand_mounted')
  extra=$(jq -n --slurpfile r "$REF_DIR/routes.json" --slurpfile c "$CAND_DIR/routes.json" '
    [ $c[0][] | select(.mounted) | .prefix ] as $cand_mounted
    | [ $r[0][] | select(.mounted) | .prefix ] as $ref_mounted
    | $cand_mounted - $ref_mounted')
  n_missing=$(echo "$missing" | jq 'length')
  n_extra=$(echo "$extra" | jq 'length')
  total=$(jq 'length' "$REF_DIR/routes.json")
  if [[ "$n_missing" == "0" ]]; then
    row PASS "Route mounts" "all $total probed prefixes mounted on both environments"
  else
    row FAIL "Route mounts" "$n_missing prefixes mounted on $REF_LABEL but NOT on $CAND_LABEL: $(echo "$missing" | jq -cr '.[0:10] | join(", ")')$( [[ $n_missing -gt 10 ]] && echo " (+$((n_missing-10)) more)" )"
  fi
  [[ "$n_extra" != "0" ]] && row WARN "Route mounts (extra)" "$n_extra prefixes mounted on $CAND_LABEL only: $(echo "$extra" | jq -cr '.[0:10] | join(", ")')"
else
  row WARN "Route mounts" "routes.json missing on one side — probe did not run"
fi

# --------------------------------------------------------------------- 7. CORS
ref_cors=$(grep -i 'access-control-allow-origin' "$REF_DIR/cors-preflight.txt" 2>/dev/null | head -1)
cand_cors=$(grep -i 'access-control-allow-origin' "$CAND_DIR/cors-preflight.txt" 2>/dev/null | head -1)
if [[ -n "$cand_cors" ]]; then
  row PASS "CORS preflight" "$CAND_LABEL answers preflight (${cand_cors})"
elif [[ -n "$ref_cors" ]]; then
  row FAIL "CORS preflight" "$REF_LABEL sends Access-Control-Allow-Origin but $CAND_LABEL does not — browser calls from the frontend will fail"
else
  row INFO "CORS preflight" "neither environment answered preflight with ACAO (may be same-origin by design) — verify from a real browser session"
fi

# --------------------------------------------------------- 8. security headers
for h in strict-transport-security x-content-type-options; do
  ref_h=$(grep -i "^$h:" "$REF_DIR/gateway-headers.txt" 2>/dev/null | head -1)
  cand_h=$(grep -i "^$h:" "$CAND_DIR/gateway-headers.txt" 2>/dev/null | head -1)
  if [[ -n "$ref_h" && -z "$cand_h" ]]; then
    row WARN "Header: $h" "present on $REF_LABEL, missing on $CAND_LABEL"
  elif [[ -n "$cand_h" || -z "$ref_h" ]]; then
    row PASS "Header: $h" "parity OK"
  fi
done

# ----------------------------------------------------------------- 9. websocket
ref_ws=$(jf "$REF_DIR/websocket-probe.json" '.http_code')
cand_ws=$(jf "$CAND_DIR/websocket-probe.json" '.http_code')
if [[ "$cand_ws" == "$ref_ws" ]]; then
  row PASS "WebSocket upgrade path" "both answer HTTP $ref_ws to an Upgrade request"
elif [[ "$cand_ws" == "502" || "$cand_ws" == "504" || "$cand_ws" == "000" ]]; then
  row FAIL "WebSocket upgrade path" "$REF_LABEL→$ref_ws vs $CAND_LABEL→$cand_ws — the AWS load balancer likely does not pass WebSocket upgrades; ORB voice will be dead"
else
  row WARN "WebSocket upgrade path" "$REF_LABEL→$ref_ws vs $CAND_LABEL→$cand_ws — different but app-level; verify ORB voice manually"
fi

# ------------------------------------------------------------------ 10. latency
lat() { sort -n "$1" 2>/dev/null | awk '{a[NR]=$1} END {if (NR) printf "%.3f", a[(NR+1)/2]}'; }
ref_lat=$(lat "$REF_DIR/latency-samples.txt"); cand_lat=$(lat "$CAND_DIR/latency-samples.txt")
if [[ -n "$ref_lat" && -n "$cand_lat" ]]; then
  slow=$(awk -v r="$ref_lat" -v c="$cand_lat" 'BEGIN {print (c > r*3 && c > 1.0) ? 1 : 0}')
  if [[ "$slow" == "1" ]]; then
    row WARN "Latency (median health)" "$REF_LABEL=${ref_lat}s vs $CAND_LABEL=${cand_lat}s — >3x slower; check warm instances (GCP runs min-instances=1: cold ORB session/start ~9.4s blows the widget's 8s timeout)"
  else
    row PASS "Latency (median health)" "$REF_LABEL=${ref_lat}s vs $CAND_LABEL=${cand_lat}s"
  fi
fi

# ----------------------------------------------------------------- 11. frontend
for side in "$REF_DIR:$REF_LABEL" "$CAND_DIR:$CAND_LABEL"; do
  d="${side%%:*}"; l="${side##*:}"
  [[ -f "$d/frontend.meta.json" ]] || continue
  fcode=$(jf "$d/frontend.meta.json" '.http_code')
  [[ "$fcode" == "200" ]] && row PASS "$l frontend reachable" "GET / → 200" \
                          || row FAIL "$l frontend reachable" "GET / → HTTP ${fcode:-none}"
  spa=$(jf "$d/frontend-spa-fallback.json" '.deep_route_http_code')
  if [[ -n "$spa" ]]; then
    [[ "$spa" == "200" ]] && row PASS "$l SPA fallback" "deep route /settings → 200" \
                          || row FAIL "$l SPA fallback" "deep route /settings → HTTP $spa — static host must rewrite unknown paths to index.html"
  fi
done

if [[ -f "$CAND_DIR/frontend-wiring.json" ]]; then
  cand_gw_urls=$(jq -cr '.urls // []' "$CAND_DIR/frontend-wiring.json" 2>/dev/null || echo '[]')
  cand_gateway=$(jq -r '.gateway' "$CAND_DIR/snapshot.json" 2>/dev/null)
  cand_gw_host=$(echo "$cand_gateway" | sed -E 's|https?://||; s|/.*||')
  if echo "$cand_gw_urls" | grep -qF "$cand_gw_host"; then
    row PASS "$CAND_LABEL frontend→gateway wiring" "bundle bakes in $cand_gw_host"
  else
    row FAIL "$CAND_LABEL frontend→gateway wiring" "bundle gateway URLs $cand_gw_urls do not include the $CAND_LABEL gateway ($cand_gw_host) — the AWS frontend is silently calling another environment's API"
  fi
  ref_supa_urls=$(jq -cr '.supabase_urls' "$REF_DIR/frontend-wiring.json" 2>/dev/null || echo '[]')
  cand_supa_urls=$(jq -cr '.supabase_urls' "$CAND_DIR/frontend-wiring.json" 2>/dev/null || echo '[]')
  if [[ "$ref_supa_urls" == "$cand_supa_urls" ]]; then
    row PASS "Frontend Supabase wiring" "identical baked Supabase URLs: $cand_supa_urls"
  else
    row FAIL "Frontend Supabase wiring" "$REF_LABEL=$ref_supa_urls vs $CAND_LABEL=$cand_supa_urls — logins on one frontend will be anonymous to the gateway"
  fi
fi

# -------------------------------------------------------------------- report
{
  echo "# AWS↔GCP staging parity report"
  echo
  echo "- Reference: **$REF_LABEL** ($(jq -r .gateway "$REF_DIR/snapshot.json" 2>/dev/null))"
  echo "- Candidate: **$CAND_LABEL** ($(jq -r .gateway "$CAND_DIR/snapshot.json" 2>/dev/null))"
  echo "- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "| Status | Check | Detail |"
  echo "|--------|-------|--------|"
  printf '%s' "$ROWS"
  echo
  if [[ $FAILS -gt 0 ]]; then
    echo "**RESULT: FAIL** — $FAILS failing check(s), $WARNS warning(s). The AWS staging environment is NOT yet equivalent."
  elif [[ $WARNS -gt 0 ]]; then
    echo "**RESULT: PASS WITH WARNINGS** — $WARNS warning(s) need human review, then run the manual checklist in docs/AWS-STAGING-VALIDATION.md."
  else
    echo "**RESULT: PASS** — automated parity checks clean. Continue with the manual checklist in docs/AWS-STAGING-VALIDATION.md."
  fi
} > "$REPORT"

[[ "$REPORT" != "/dev/stdout" ]] && cat "$REPORT"
exit $(( FAILS > 0 ? 1 : 0 ))
