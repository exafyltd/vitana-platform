#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID not set}"
: "${REGION:?REGION not set}"
: "${MODEL:?MODEL not set}"
: "${ACCESS_TOKEN:?ACCESS_TOKEN not set}"

N=${1:-10}
URL="$(printf 'https://%s-aiplatform.googleapis.com/v1beta1/projects/%s/locations/%s/publishers/google/models/%s:generateContent' "$REGION" "$PROJECT_ID" "$REGION" "$MODEL")"
REQ='{"contents":[{"role":"user","parts":[{"text":"Return a haiku about hydration."}]}],"generationConfig":{"temperature":0,"maxOutputTokens":64}}'

run() {
  curl -sS -o /dev/null \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -X POST "$URL" -d "$REQ" \
    -w "%{http_code} %{time_total}\n"
}

export -f run
export URL ACCESS_TOKEN REQ

tmp="$(mktemp)"
seq "$N" | xargs -n1 -P"$N" bash -c 'run' > "$tmp"

echo "== Concurrency: $N =="
echo "-- Status code distribution --"
awk '{print $1}' "$tmp" | sort | uniq -c | sort -nr

echo "-- Latency (s): p50/p90/p95/max --"
awk '{print $2}' "$tmp" | sort -n | awk '
  {a[NR]=$1}
  END {
    if (NR==0) {print "no samples"; exit 1}
    p50=a[int(0.50*NR)]; if (!p50) p50=a[NR]
    p90=a[int(0.90*NR)]; if (!p90) p90=a[NR]
    p95=a[int(0.95*NR)]; if (!p95) p95=a[NR]
    printf "p50=%ss  p90=%ss  p95=%ss  max=%ss\n", p50, p90, p95, a[NR]
  }'

rm -f "$tmp"
