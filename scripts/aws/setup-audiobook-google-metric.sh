#!/usr/bin/env bash
# VTID-05026 — CloudWatch metric filter + alarm for Audiobook Google narration.
#
# Every Google render of a Russian or Serbian Audiobook episode logs one JSON
# line: {"event":"audiobook_google_tts","ok":true,"chars":2001,...}
# (services/gateway/src/services/guided-journey/audiobook-episode-audio.ts).
# This script turns those lines into the metric
# Vitana/Audiobook AudiobookGoogleTtsChars (sum of characters sent to Google)
# for staging and production, and alarms on production's daily total.
#
# The in-process cap (AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK) is per task
# and approximate; this metric is the real total across tasks and deploys.
#
# Dry run by default (prints what it would do). --apply creates or updates.
# Idempotent: put-metric-filter and put-metric-alarm overwrite by name.
#
# Usage:
#   scripts/aws/setup-audiobook-google-metric.sh            # dry run
#   scripts/aws/setup-audiobook-google-metric.sh --apply
#   ALARM_DAILY_CHARS=3000000 scripts/aws/setup-audiobook-google-metric.sh --apply
set -euo pipefail

REGION="eu-central-1"
ACCOUNT="472838866351"
NAMESPACE="Vitana/Audiobook"
METRIC="AudiobookGoogleTtsChars"
FILTER_NAME="vitana-audiobook-google-tts-chars"
PATTERN='{ $.event = "audiobook_google_tts" }'
# Production daily total above which the alarm fires. Default 2,000,000
# characters (about two full renders of both languages' catalogue).
ALARM_DAILY_CHARS="${ALARM_DAILY_CHARS:-2000000}"
ALARM_NAME="vitana-audiobook-google-tts-chars-daily-high"
ALARM_TOPIC="arn:aws:sns:${REGION}:${ACCOUNT}:vitana-alarms-prod"

APPLY=false
[ "${1:-}" = "--apply" ] && APPLY=true

run() {
  if $APPLY; then "$@"; else printf '[dry-run] %q ' "$@"; echo; fi
}

# env label -> log group
for pair in "staging:/vitana/gateway" "production:/vitana/gateway-awsdr"; do
  ENV_LABEL="${pair%%:*}"
  GROUP="${pair#*:}"
  run aws logs put-metric-filter --region "$REGION" \
    --log-group-name "$GROUP" \
    --filter-name "$FILTER_NAME" \
    --filter-pattern "$PATTERN" \
    --metric-transformations \
      "metricName=${METRIC},metricNamespace=${NAMESPACE},metricValue=\$.chars,defaultValue=0,dimensions={Environment=${ENV_LABEL}},unit=Count"
done

run aws cloudwatch put-metric-alarm --region "$REGION" \
  --alarm-name "$ALARM_NAME" \
  --alarm-description "VTID-05026: Audiobook Google TTS characters in production over ${ALARM_DAILY_CHARS} per day. Review AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK." \
  --namespace "$NAMESPACE" --metric-name "$METRIC" \
  --dimensions Name=Environment,Value=production \
  --statistic Sum --period 86400 --evaluation-periods 1 \
  --threshold "$ALARM_DAILY_CHARS" --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions "$ALARM_TOPIC"

$APPLY && echo "Applied." || echo "Dry run only. Re-run with --apply."
