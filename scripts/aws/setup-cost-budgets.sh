#!/usr/bin/env bash
# VTID-04328 — monthly cost guardrails for AWS account 472838866351
# (Orchestrator plan §8.6, owner decision 2026-09-23).
#
# Owner's target: a moderate monthly budget for AWS including Claude,
# "should not exceed 6,000 these days and over time grow up to max 10,000 USD".
# Claude runs on AWS Bedrock (CLAUDE.md ALWAYS 10a), so Bedrock spend is
# already part of the AWS bill and is covered by these budgets. DeepSeek is
# billed outside AWS and is NOT covered here.
#
# Creates (or updates) three AWS Budgets:
#   vitana-monthly-operating   limit = --limit (default 6000 USD)
#       actual 50% / 80% / 100%, forecast 100%  -> email
#   vitana-monthly-hard-ceiling limit = 10000 USD (fixed ceiling)
#       actual 90% / 100%, forecast 100%          -> email
#   vitana-monthly-bedrock      limit = --bedrock-limit (default 2500 USD),
#       filtered to the Bedrock service line(s); actual 80% / 100% -> email
#
# Bedrock caveat: Anthropic models on Bedrock can be billed as their own
# Marketplace service lines ("Claude ... (Amazon Bedrock Edition)"), not
# under "Amazon Bedrock". Check the exact names in Cost Explorer (group by
# Service) and pass them all with --bedrock-services "A,B,C". The operating
# and ceiling budgets are unfiltered, so they cover Claude either way.
#
# To grow the operating budget later, re-run with a higher --limit (never
# above the 10,000 ceiling; the script refuses).
#
# Needs budgets:ViewBudget + budgets:ModifyBudget in the payer account.
# The claude-code-aws-agent session identity is explicitly denied these by
# its permissions boundary, so the platform owner runs this.
#
# Usage:
#   scripts/aws/setup-cost-budgets.sh --email you@example.com            # dry run
#   scripts/aws/setup-cost-budgets.sh --email you@example.com --apply
#   scripts/aws/setup-cost-budgets.sh --email you@example.com --limit 7500 --apply
set -euo pipefail

ACCOUNT_ID="472838866351"
CEILING=10000
LIMIT=6000
BEDROCK_LIMIT=2500
BEDROCK_SERVICES="Amazon Bedrock"
EMAIL=""
APPLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --bedrock-limit) BEDROCK_LIMIT="$2"; shift 2 ;;
    --bedrock-services) BEDROCK_SERVICES="$2"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    -h|--help) sed -n '2,39p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$EMAIL" ] || { echo "--email is required (budget alerts go there)" >&2; exit 2; }
[[ "$LIMIT" =~ ^[0-9]+$ ]] || { echo "--limit must be a whole number of USD" >&2; exit 2; }
[[ "$BEDROCK_LIMIT" =~ ^[0-9]+$ ]] || { echo "--bedrock-limit must be a whole number of USD" >&2; exit 2; }
if [ "$LIMIT" -gt "$CEILING" ]; then
  echo "refused: --limit $LIMIT is above the owner's ceiling of $CEILING USD" >&2; exit 2
fi
if [ "$BEDROCK_LIMIT" -gt "$LIMIT" ]; then
  echo "refused: --bedrock-limit $BEDROCK_LIMIT is above the operating limit $LIMIT" >&2; exit 2
fi

budget_json() { # name amount [service-filter]
  local name="$1" amount="$2" svc="${3:-}"
  local filter='{}'
  if [ -n "$svc" ]; then
    filter="{\"Service\":[$(printf '%s' "$svc" | awk -F, '{for(i=1;i<=NF;i++){gsub(/^ +| +$/,"",$i); printf "%s\"%s\"", (i>1?",":""), $i}}')]}"
  fi
  cat <<JSON
{"BudgetName":"$name","BudgetLimit":{"Amount":"$amount","Unit":"USD"},
 "TimeUnit":"MONTHLY","BudgetType":"COST","CostFilters":$filter,
 "CostTypes":{"IncludeTax":true,"IncludeSubscription":true,"UseBlended":false,"IncludeRefund":false,"IncludeCredit":false,"IncludeUpfront":true,"IncludeRecurring":true,"IncludeOtherSubscription":true,"IncludeSupport":true,"IncludeDiscount":true,"UseAmortized":false}}
JSON
}

notif_json() { # type threshold
  cat <<JSON
{"Notification":{"NotificationType":"$1","ComparisonOperator":"GREATER_THAN","Threshold":$2,"ThresholdType":"PERCENTAGE"},
 "Subscribers":[{"SubscriptionType":"EMAIL","Address":"$EMAIL"}]}
JSON
}

run() { if $APPLY; then "$@"; else printf 'DRY RUN:'; printf ' %q' "$@"; echo; fi; }

upsert_budget() { # name amount service notifications...
  local name="$1" amount="$2" svc="$3"; shift 3
  local body; body="$(budget_json "$name" "$amount" "$svc")"
  if $APPLY && aws budgets describe-budget --account-id "$ACCOUNT_ID" --budget-name "$name" >/dev/null 2>&1; then
    run aws budgets update-budget --account-id "$ACCOUNT_ID" --new-budget "$body"
    echo "updated $name -> $amount USD (existing alerts kept)"
    return
  fi
  local notifs="["; local first=true
  for n in "$@"; do $first || notifs+=","; first=false; notifs+="$(notif_json ${n%%:*} ${n##*:})"; done
  notifs+="]"
  run aws budgets create-budget --account-id "$ACCOUNT_ID" --budget "$body" \
    --notifications-with-subscribers "$notifs"
  if $APPLY; then echo "created $name -> $amount USD"; else echo "would create $name -> $amount USD"; fi
}

echo "account $ACCOUNT_ID  operating=$LIMIT USD  ceiling=$CEILING USD  bedrock=$BEDROCK_LIMIT USD  apply=$APPLY"
upsert_budget vitana-monthly-operating "$LIMIT" "" ACTUAL:50 ACTUAL:80 ACTUAL:100 FORECASTED:100
upsert_budget vitana-monthly-hard-ceiling "$CEILING" "" ACTUAL:90 ACTUAL:100 FORECASTED:100
upsert_budget vitana-monthly-bedrock "$BEDROCK_LIMIT" "$BEDROCK_SERVICES" ACTUAL:80 ACTUAL:100
$APPLY || echo "dry run only — re-run with --apply to create the budgets"
