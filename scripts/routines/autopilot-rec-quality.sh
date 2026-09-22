#!/usr/bin/env bash
# Autopilot Recommendation Quality routine (VTID-02006, reporting added VTID-04292).
# Daily 06:30 UTC. Run from the scheduled Claude Code routine:
#   ROUTINE_TOKEN=<token> bash scripts/routines/autopilot-rec-quality.sh
# The token is supplied by the routine prompt and must never be committed.
#
# Reports, every day, on the Command Hub Routines screen:
#   - Dev Autopilot: new findings and fixes executed in the last 24h
#   - Community recommendation drift (null pillar, acceptance, volume)
# On a drift breach it emits autopilot.recommendations.quality_drift so the
# gateway routes it to self-healing. The run is never left in 'running'.

G="${ROUTINE_GATEWAY_URL:-https://preview-aws-gateway.vitanaland.com}"
T="${ROUTINE_TOKEN:?ROUTINE_TOKEN is required}"
H="X-Routine-Token: $T"
N=autopilot-rec-quality

RUN=$(curl -sS --max-time 20 -X POST "$G/api/v1/routines/$N/runs" -H "$H" -H 'Content-Type: application/json' -d '{"trigger":"cron"}' | jq -r '.run.id // empty')
if [ -z "$RUN" ]; then
  echo "run creation failed against $G (token not configured on the gateway, or gateway unreachable)" >&2
  exit 1
fi
fail(){ curl -sS -X PATCH "$G/api/v1/routines/$N/runs/$RUN" -H "$H" -H 'Content-Type: application/json' -d "$(jq -nc --arg s "$1" --arg e "$2" '{status:"failure",summary:$s,error:$e}')" >/dev/null; }

# --- Dev Autopilot daily numbers ------------------------------------------
DEV=$(curl -sS --max-time 20 -H "$H" "$G/api/v1/routines/audits/dev-autopilot-daily")
if echo "$DEV" | jq -e '.ok==true' >/dev/null 2>&1; then
  DEV_OK=1
  D_FIND=$(echo "$DEV" | jq '.new_findings')
  D_FIXED=$(echo "$DEV" | jq '.fixes_completed')
  D_STARTED=$(echo "$DEV" | jq '.executions_started')
  D_PRS=$(echo "$DEV" | jq '.prs_opened')
  D_FAILED=$(echo "$DEV" | jq '.fixes_failed')
  D_HELD=$(echo "$DEV" | jq '.awaiting_approval_now')
  D_FLIGHT=$(echo "$DEV" | jq '.in_flight_now')
  DEV_LINE="📊 Dev Autopilot 24h: $D_FIND new findings · $D_FIXED fixes completed ($D_STARTED runs started, $D_PRS PRs opened, $D_FAILED failed; $D_FLIGHT in flight, $D_HELD awaiting approval)"
  DEV_JSON=$(echo "$DEV" | jq 'del(.ok)')
else
  DEV_OK=0
  DEV_LINE="📊 Dev Autopilot 24h: unavailable ($(echo "$DEV" | head -c 120))"
  DEV_JSON=null
fi

# --- Community recommendation quality -------------------------------------
DATA=$(curl -sS --max-time 20 -H "$H" "$G/api/v1/routines/audits/autopilot-recs")
echo "$DATA" | jq -e '.ok==true' >/dev/null 2>&1 || { fail "❌ autopilot-recs audit unreachable | $DEV_LINE" "$(echo "$DATA" | head -c 300)"; exit 0; }

Y_TOT=$(echo "$DATA" | jq '.yesterday.total // 0')
Y_NULL_RATE=$(echo "$DATA" | jq '.yesterday.null_pillar_rate // 0')
Y_ACC_RATE=$(echo "$DATA" | jq '.yesterday.acceptance_rate // null')
B_ACC_RATE=$(echo "$DATA" | jq '.baseline_window.acceptance_rate // null')
B_AVG_TOT=$(echo "$DATA" | jq '.baseline_avg_per_day.total // 0')

BKS=()
[ "$(awk -v r="$Y_NULL_RATE" 'BEGIN{print (r>0.10)?1:0}')" = "1" ] && BKS+=(null_pillar)
if [ "$Y_ACC_RATE" != "null" ] && [ "$B_ACC_RATE" != "null" ]; then
  [ "$(awk -v y="$Y_ACC_RATE" -v b="$B_ACC_RATE" 'BEGIN{print (y < b*0.5)?1:0}')" = "1" ] && BKS+=(acceptance_collapse)
fi
[ "$B_AVG_TOT" -gt 0 ] && [ "$Y_TOT" -lt $((B_AVG_TOT * 30 / 100)) ] && BKS+=(volume_collapse)

SH_ACTION=null SH_VTID=null SH_REASON=null SH_EVENT=null
KSTR=""
if [ ${#BKS[@]} -gt 0 ]; then
  IFS=, ; KSTR="${BKS[*]}" ; unset IFS
  PAYLOAD=$(jq -nc --arg msg "Autopilot drift: $KSTR" --arg ks "$KSTR" --argjson y "$(echo "$DATA" | jq '.yesterday')" --argjson bavg "$(echo "$DATA" | jq '.baseline_avg_per_day')" '{vtid:"VTID-02006",type:"autopilot.recommendations.quality_drift",source:"routine.autopilot-rec-quality",status:"warning",message:$msg,payload:{yesterday:$y,baseline_avg_per_day:$bavg,breach_kinds:($ks|split(","))}}')
  RESP=$(curl -sS --max-time 20 -X POST "$G/api/v1/events/ingest" -H 'Content-Type: application/json' -d "$PAYLOAD")
  if echo "$RESP" | jq -e '.ok==true' >/dev/null 2>&1; then
    SH_EVENT=$(echo "$RESP" | jq -r '.event_id // "null"')
    SH_ACTION=$(echo "$RESP" | jq -r '.self_healing_action // "null"')
    SH_VTID=$(echo "$RESP" | jq -r '.self_healing_vtid // "null"')
    SH_REASON=$(echo "$RESP" | jq -r '.self_healing_reason // "null"')
  fi
fi

if [ ${#BKS[@]} -eq 0 ]; then
  REC_LINE="✅ Recs healthy: $Y_TOT recs, accept=$Y_ACC_RATE null_pillar=$Y_NULL_RATE"
  STATUS=success
else
  REC_LINE="⚠️ Rec drift: $KSTR. Self-healing $SH_ACTION VTID=$SH_VTID ($SH_REASON)"
  STATUS=partial
fi
[ "$DEV_OK" = "1" ] || STATUS=partial
SUMM="$DEV_LINE | $REC_LINE"

FINDINGS=$(jq -nc --argjson dev "$DEV_JSON" --argjson y "$(echo "$DATA" | jq '.yesterday')" --argjson bavg "$(echo "$DATA" | jq '.baseline_avg_per_day')" --arg ks "$KSTR" \
  --arg evt "$SH_EVENT" --arg act "$SH_ACTION" --arg vtid "$SH_VTID" --arg rsn "$SH_REASON" \
  '{dev_autopilot:$dev,yesterday:$y,baseline_avg_per_day:$bavg,breach_kinds:(if $ks=="" then [] else ($ks|split(",")) end),self_healing:{event_id:$evt,action:$act,vtid:$vtid,reason:$rsn}}')

curl -sS -X PATCH "$G/api/v1/routines/$N/runs/$RUN" -H "$H" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg st "$STATUS" --arg s "${SUMM:0:1990}" --argjson f "$FINDINGS" '{status:$st,summary:$s,findings:$f}')" >/dev/null

echo "$SUMM"
