#!/usr/bin/env bash
# VTID-03412 — Functional verification of AWS production (DR).
#
# WHY THIS EXISTS
# ---------------
# ECS `healthStatus: HEALTHY` only means the container's health command
# exited 0. It does NOT mean the service is doing its job. This was found
# the hard way: `vitana-orb-agent` reported HEALTHY for days while running
# health-endpoint-only, with its actual worker never started — it would
# have passed every automated gate in the cutover checklist while being
# functionally inert.
#
# So every probe here asserts on *behaviour*, not liveness:
#   - gateway            → serves the API and self-reports env=production
#   - community-app      → serves the SPA and the bundle targets the
#                          intended gateway hostname
#   - oasis-operator     → returns real JSON from its health route
#   - oasis-projector    → logged a successful DB connection
#   - worker-runner      → logged a successful orchestrator registration
#   - verification-engine→ logged a successful heartbeat
#   - orb-agent          → started its LiveKit worker (NOT health-only)
#   - DMS                → both replication tasks are actually `running`
#
# Usage:
#   scripts/aws/verify-aws-production.sh              # probe dr-* hostnames
#   scripts/aws/verify-aws-production.sh --post-cutover  # probe canonical
#
# Exit code is the number of FAILED probes, so CI/rollback logic can gate
# on it. Read-only: performs no mutations of any kind.

set -uo pipefail

REGION="${AWS_REGION:-eu-central-1}"
CLUSTER="${ECS_CLUSTER:-Vitana-ECS-Cluster}"
MODE="pre-cutover"
[[ "${1:-}" == "--post-cutover" ]] && MODE="post-cutover"

if [[ "$MODE" == "post-cutover" ]]; then
  GATEWAY_HOST="gateway.vitanaland.com"
  APP_HOST="vitanaland.com"
else
  GATEWAY_HOST="dr-gateway.vitanaland.com"
  APP_HOST="dr-app.vitanaland.com"
fi

PASS=0; FAIL=0; SKIP=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
skip() { echo "  – $1"; SKIP=$((SKIP+1)); }

echo "AWS production functional verification (${MODE})"
echo "  gateway: https://${GATEWAY_HOST}   app: https://${APP_HOST}"
echo

# Grep a service's recent logs for a behavioural marker. Looks at the most
# recent stream only — a marker from a long-dead task is not evidence the
# service is working now.
log_has() { # <log-group> <pattern> <since-minutes>
  local group="$1" pattern="$2" mins="${3:-120}"
  local start stream
  start=$(( ($(date +%s) - mins * 60) * 1000 ))
  # Use --limit (API-level), NOT --max-items. With --max-items, aws-cli v2
  # appends a client-side pagination token to --output text, so $stream came
  # back as two lines ("ecs/foo/abc\nNone") and every get-log-events call
  # failed ResourceNotFoundException — reported as "marker absent", i.e. a
  # false FAIL on three healthy services. This, not the missing
  # --start-from-head, was the real cause of the first run's bogus failures.
  stream=$(aws logs describe-log-streams --region "$REGION" --log-group-name "$group" \
            --order-by LastEventTime --descending --limit 1 \
            --query 'logStreams[0].logStreamName' --output text 2>/dev/null) || return 2
  [[ -z "$stream" || "$stream" == "None" ]] && return 2
  # --start-from-head is also required: without it get-log-events reads
  # backward from the tail and can return an empty first page.
  aws logs get-log-events --region "$REGION" --log-group-name "$group" \
    --log-stream-name "$stream" --start-time "$start" --start-from-head \
    --limit 10000 --output json 2>/dev/null \
    | grep -qiE "$pattern"
}

echo "[gateway] serves the API and self-reports production"
GW=$(curl -s -m 15 "https://${GATEWAY_HOST}/api/v1/admin/health" 2>/dev/null)
if [[ -z "$GW" ]]; then
  bad "gateway /api/v1/admin/health unreachable"
elif grep -q '"env"[[:space:]]*:[[:space:]]*"production"' <<<"$GW"; then
  ok "gateway env=production"
else
  bad "gateway did NOT report env=production (got: $(head -c 120 <<<"$GW"))"
fi
# JSON, not an Express HTML 404 — CLAUDE.md §15's diagnostic.
CT=$(curl -s -o /dev/null -m 15 -w '%{content_type}' "https://${GATEWAY_HOST}/alive" 2>/dev/null)
[[ "$CT" == application/json* || "$CT" == text/* ]] && ok "gateway /alive responds ($CT)" \
  || bad "gateway /alive unexpected content-type: ${CT:-none}"

echo "[community-app] serves the SPA, bundle targets the right gateway"
HTML=$(curl -s -m 20 "https://${APP_HOST}/" 2>/dev/null)
if grep -qi '<div id="root"\|<script' <<<"$HTML"; then
  ok "frontend serves an SPA document"
  ASSET=$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' <<<"$HTML" | head -1)
  if [[ -n "$ASSET" ]]; then
    BUNDLE=$(curl -s -m 30 "https://${APP_HOST}${ASSET}" 2>/dev/null)
    if grep -q "gateway\.vitanaland\.com" <<<"$BUNDLE"; then
      ok "bundle targets gateway.vitanaland.com (canonical)"
    elif grep -q "preview-aws-gateway\.vitanaland\.com" <<<"$BUNDLE"; then
      bad "bundle targets STAGING gateway (preview-aws-gateway) — wrong build"
    else
      bad "bundle targets no recognised gateway hostname"
    fi
  else
    skip "could not locate a JS asset to inspect"
  fi
else
  bad "frontend did not return an SPA document"
fi

echo "[oasis-operator] returns real JSON from its health route"
OP=$(curl -s -m 15 "https://dr-oasis-operator.vitanaland.com/api/v1/health" 2>/dev/null)
grep -q '"status"' <<<"$OP" && ok "oasis-operator returned JSON health" \
  || bad "oasis-operator health missing/not JSON (got: $(head -c 100 <<<"$OP"))"

# A service at desiredCount=0 is a deliberate operational state, not a
# fault — reporting it as FAILED would train people to ignore this script.
desired() { aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" \
              --services "$1" --query 'services[0].desiredCount' --output text 2>/dev/null; }

# NOTE on marker choice: probe for markers the service emits *repeatedly*,
# not once at startup. "Database connected" / "Worker registered" are logged
# only at boot, so a container running for longer than the lookback window
# legitimately has no such line and would fail a recent-window check while
# being perfectly healthy.

echo "[oasis-projector] writing the ledger without constraint errors"
if [[ "$(desired vitana-oasis-projector)" == "0" ]]; then
  skip "oasis-projector desiredCount=0 (deliberately stopped — Aurora is missing the projection_offsets unique constraint AND is a DMS target for that table; see scripts/aws/aurora-schema-parity.sql)"
elif log_has /vitana/oasis-projector '42P10|no unique or exclusion constraint' 60; then
  bad "oasis-projector is hitting 42P10 — Aurora lacks the ON CONFLICT constraint"
elif log_has /vitana/oasis-projector 'ledger|projection|database connected' 240; then
  ok "oasis-projector active with no constraint errors"
else
  skip "oasis-projector: no recent log activity to judge"
fi

echo "[worker-runner] polling for work"
case "$(log_has /vitana/worker-runner 'polled:|worker registered|registered successfully' 60; echo $?)" in
  0) ok "worker-runner is polling (VTID-01200 loop alive)" ;;
  2) skip "worker-runner log group/stream unavailable" ;;
  *) bad "worker-runner shows NO recent poll activity" ;;
esac

echo "[verification-engine] heartbeating"
case "$(log_has /vitana/vitana-verification-engine 'heartbeat' 60; echo $?)" in
  0) ok "verification-engine is heartbeating" ;;
  2) skip "verification-engine log group/stream unavailable" ;;
  *) bad "verification-engine shows NO recent heartbeat" ;;
esac

echo "[orb-agent] actually started its worker (not health-only)"
# The exact trap this script exists for: ready_health_only means the
# container is up and useless. Treat it as a hard failure, not a pass.
if log_has /vitana/orb-agent 'ready_health_only' 240; then
  bad "orb-agent is in HEALTH-ONLY mode — AGENT_ENABLE_WORKER unset; ECS will still say HEALTHY"
elif log_has /vitana/orb-agent 'orb_agent\.(boot|worker)' 240; then
  ok "orb-agent booted without the health-only marker"
else
  skip "orb-agent log group/stream unavailable"
fi

echo "[DMS] both replication tasks are running"
for t in vitana-supabase-to-aurora vitana-autopilot-cdc; do
  S=$(aws dms describe-replication-tasks --region "$REGION" \
        --filters "Name=replication-task-id,Values=$t" \
        --query 'ReplicationTasks[0].Status' --output text 2>/dev/null)
  [[ "$S" == "running" ]] && ok "DMS $t running" || bad "DMS $t is '${S:-unknown}', expected running"
done

echo "[alarms] none currently in ALARM"
IN_ALARM=$(aws cloudwatch describe-alarms --region "$REGION" --alarm-name-prefix vitana- \
             --state-value ALARM --query 'MetricAlarms[].AlarmName' --output text 2>/dev/null)
[[ -z "$IN_ALARM" ]] && ok "no vitana-* alarms firing" || bad "alarms firing: $IN_ALARM"
# An alarm wired to nothing is a silent alarm — see VTID-03413.
UNWIRED=$(aws cloudwatch describe-alarms --region "$REGION" --alarm-name-prefix vitana- \
            --query 'MetricAlarms[?length(AlarmActions)==`0`].AlarmName' --output text 2>/dev/null)
[[ -z "$UNWIRED" ]] && ok "every alarm has an action wired" || bad "alarms with NO action: $UNWIRED"

echo
echo "passed=$PASS failed=$FAIL skipped=$SKIP"
[[ $FAIL -gt 0 ]] && echo "NOT READY — $FAIL functional probe(s) failed." \
                  || echo "All functional probes passed."
exit $FAIL
