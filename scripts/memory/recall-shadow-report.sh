#!/usr/bin/env bash
# VTID-04784: summarise the '[VTID-04784] recall-shadow' lines (memory plan
# phase 2) — does recall() give the ORB the same memory as the legacy read?
# Read-only: CloudWatch filter-log-events only.
#
#   scripts/memory/recall-shadow-report.sh [log-group] [hours]
#   scripts/memory/recall-shadow-report.sh /vitana/gateway-awsdr 72   # production
#   scripts/memory/recall-shadow-report.sh /vitana/gateway 24         # staging
#
# Flip MEMORY_ORB_RECALL_ENABLED in production only when, over enough
# sessions, shadow failures are ~0, facts match (only_* and value_diff ~0,
# apart from rows the legacy read should never have shown), and recall's
# latency is no worse than the legacy read's.
set -euo pipefail
GROUP="${1:-/vitana/gateway-awsdr}"
HOURS="${2:-72}"
START=$(( ( $(date +%s) - HOURS * 3600 ) * 1000 ))

aws logs filter-log-events --region eu-central-1 --log-group-name "$GROUP" \
  --start-time "$START" --filter-pattern '"[VTID-04784] recall-shadow"' \
  --query 'events[].message' --output text |
tr '\t' '\n' | grep 'recall-shadow' |
awk '
  function kv(name,   re, m) { re = name "=[^ ]+"; if (match($0, re)) { return substr($0, RSTART + length(name) + 1, RLENGTH - length(name) - 1) } return "" }
  /failed:/ { failed++; next }
  {
    n++
    served[kv("served")]++
    if (kv("ok") != "true") notok++
    split(kv("facts"), f, "/"); fs += f[1]; fh += f[2]
    os = kv("only_served") + 0; oh = kv("only_shadow") + 0; vd = kv("value_diff") + 0
    sum_os += os; sum_oh += oh; sum_vd += vd
    if (os == 0 && oh == 0 && vd == 0) same++
    split(kv("ms"), m, "/"); ms_s[n] = m[1] + 0; ms_h[n] = m[2] + 0
    split(kv("chars"), c, "/"); cs += c[1]; ch += c[2]
  }
  function pct(arr, k,   i, j, t, tmp, cnt) {
    cnt = 0; for (i in arr) tmp[++cnt] = arr[i]
    for (i = 1; i <= cnt; i++) for (j = i + 1; j <= cnt; j++) if (tmp[j] < tmp[i]) { t = tmp[i]; tmp[i] = tmp[j]; tmp[j] = t }
    return cnt ? tmp[int((cnt - 1) * k) + 1] : 0
  }
  END {
    printf "log group: %s, last %s h\n", "'"$GROUP"'", "'"$HOURS"'"
    if (!n) { printf "no recall-shadow lines (failed=%d) — is MEMORY_ORB_RECALL_SHADOW=true on this gateway?\n", failed; exit }
    printf "sessions compared: %d   shadow read failed: %d   shadow not ok: %d\n", n, failed, notok
    for (p in served) printf "served by %s: %d\n", p, served[p]
    printf "facts identical: %d / %d (%.1f%%)\n", same, n, 100 * same / n
    printf "avg facts served/shadow: %.1f / %.1f\n", fs / n, fh / n
    printf "avg only_served %.2f  only_shadow %.2f  value_diff %.2f\n", sum_os / n, sum_oh / n, sum_vd / n
    printf "avg prompt chars served/shadow: %d / %d\n", cs / n, ch / n
    printf "latency ms served p50 %d p95 %d | shadow p50 %d p95 %d\n", pct(ms_s, 0.5), pct(ms_s, 0.95), pct(ms_h, 0.5), pct(ms_h, 0.95)
  }'
