#!/bin/bash
# Milestone 2 commands for the owner (plan eng-gitlab-m2, lane settings). Run in AWS CloudShell, signed in to the management account
# 472838866351, from the folder that holds setup.sh (~/vitana-eng); it reads the same state.env and uses the same Systems Manager way
# to reach the GitLab machine. No secret is printed by any command.
#
#   bash m2.sh install    once: node, the checkout, the units and the timers on the GitLab machine (runs host/ops-install.sh; safe to repeat)
#   bash m2.sh status     read only: the four timers, the drift check, the last good settings run, the alarms, the alert mail, the fleet token
#   bash m2.sh settings   pull the newest main into the checkout and run the settings sync now; prints its log
#   bash m2.sh rehearse   run the rehearsal (12 agents) on the GitLab machine and print its report
#
# Exit code: 0 when the command did what it says (status: and nothing needs attention), 1 otherwise, 2 for a usage mistake.
# M2_STATE, M2_CHECKOUT and M2_HOST_ENV exist so that scripts/eng/free-tier-guard.test.mjs can run this file against stand-ins; the owner sets none.
set -uo pipefail
# CloudShell sets AWS_REGION to the region it was opened in, and the AWS CLI prefers it over AWS_DEFAULT_REGION. Everything lives in Frankfurt.
export AWS_PAGER="" AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${M2_STATE:-$HERE/state.env}"
CHECKOUT="${M2_CHECKOUT:-/opt/vitana/platform}"
HOST_ENV="${M2_HOST_ENV:-/etc/vitana/env}"
MGMT=472838866351
FLEET_TOKEN_SECRET=vitana/engineering/gitlab/fleet-runner-token
PROBLEMS=0

die() { echo "ERROR: $*" >&2; exit 1; }
problem() { PROBLEMS=$((PROBLEMS + 1)); echo "!! $*"; }
usage() {
  cat <<'USAGE'
usage: bash m2.sh <command>
  install    node, the checkout, the units and the timers on the GitLab machine (once; safe to repeat)
  status     read only: timers, drift check, last good settings run, alarms, alert mail, fleet token
  settings   pull the newest main into the checkout and run the settings sync now
  rehearse   run the rehearsal with 12 agents and print its report
USAGE
}

# ------------------------------------------------------------------ the engineering account and the GitLab machine (as in setup.sh)
find_account() {
  [ -f "$STATE" ] && . "$STATE"
  if [ -z "${ACCOUNT_ID:-}" ]; then
    [ "$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" = "$MGMT" ] || die "run this in the management account $MGMT"
    ACCOUNT_ID="$(aws organizations list-accounts --query "Accounts[?Name=='vitana-engineering' && Status=='ACTIVE'].Id | [0]" --output text 2>/dev/null)"
    { [ -n "$ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != None ]; } || die "the AWS account vitana-engineering was not found: run setup.sh first"
  fi
}
assume() {   # temporary credentials for the engineering account (1 hour)
  local c="" i
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  for i in 1 2 3; do
    c="$(aws sts assume-role --role-arn "arn:aws:iam::$ACCOUNT_ID:role/OrganizationAccountAccessRole" --role-session-name vitana-eng-m2 --duration-seconds 3600 --query Credentials --output json 2>/dev/null)" && break
    c=""; sleep 5
  done
  [ -n "$c" ] || die "cannot assume OrganizationAccountAccessRole in $ACCOUNT_ID; are you in the management account $MGMT?"
  AWS_ACCESS_KEY_ID="$(jq -r .AccessKeyId <<<"$c")"; AWS_SECRET_ACCESS_KEY="$(jq -r .SecretAccessKey <<<"$c")"; AWS_SESSION_TOKEN="$(jq -r .SessionToken <<<"$c")"
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
}
find_instance() {   # Name tag -> id of a machine that is not terminated, or nothing
  aws ec2 describe-instances --filters "Name=tag:Name,Values=$1" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[0].InstanceId | [0]' --output text 2>/dev/null | grep -v '^None$' || true
}
connect() {
  find_account
  assume
  GITLAB_ID="${GITLAB_ID:-$(find_instance vitana-eng-gitlab)}"
  [ -n "$GITLAB_ID" ] || die "the GitLab machine vitana-eng-gitlab does not exist: run setup.sh first"
}

# ------------------------------------------------------------------ Systems Manager: run a shell script on the GitLab machine
SSM_STATUS=""; SSM_OUT=""; SSM_ERR=""; SSM_CID=""
ssm_run() {   # instance, shell script, polls of 5 seconds to wait. Sets SSM_STATUS, SSM_OUT, SSM_ERR; returns 0 when the script exited 0
  local i st params waits="${3:-60}"
  SSM_STATUS=""; SSM_OUT=""; SSM_ERR=""; SSM_CID=""
  params="$(jq -nc --arg c "$2" --arg t "${SSM_EXEC_TIMEOUT:-3600}" '{commands:[$c],executionTimeout:[$t]}')"
  SSM_CID="$(aws ssm send-command --instance-ids "$1" --document-name AWS-RunShellScript --parameters "$params" --query Command.CommandId --output text 2>/dev/null)" || SSM_CID=""
  if [ -z "$SSM_CID" ]; then
    SSM_STATUS=NotSent
    SSM_ERR="Systems Manager did not accept the command. The machine may not have registered with it yet; wait two minutes and run the command again."
    return 1
  fi
  st=""
  for i in $(seq 1 "$waits"); do
    sleep 5
    st="$(aws ssm get-command-invocation --command-id "$SSM_CID" --instance-id "$1" --query Status --output text 2>/dev/null)"
    case "$st" in InProgress|Pending|Delayed|"") ;; *) break ;; esac
  done
  SSM_STATUS="${st:-Unknown}"
  SSM_OUT="$(aws ssm get-command-invocation --command-id "$SSM_CID" --instance-id "$1" --query StandardOutputContent --output text 2>/dev/null)"
  SSM_ERR="$(aws ssm get-command-invocation --command-id "$SSM_CID" --instance-id "$1" --query StandardErrorContent --output text 2>/dev/null | tail -n 8)"
  [ "$SSM_STATUS" = Success ]
}
show_ssm() {
  [ -z "$SSM_OUT" ] || printf '%s\n' "$SSM_OUT"
  { [ -z "$SSM_ERR" ] || [ "$SSM_ERR" = None ]; } || printf '%s\n' "$SSM_ERR" >&2
}

# ------------------------------------------------------------------ what runs on the GitLab machine (POSIX sh: Run Command starts plain sh)
remote_status() {
  printf 'CK=%q\nENVF=%q\n' "$CHECKOUT" "$HOST_ENV"
  cat <<'REMOTE'
for t in vitana-platform-sync vitana-settings vitana-land vitana-ci-metrics; do
  echo "timer $t: $(systemctl is-enabled $t.timer 2>&1 | head -n 1) / $(systemctl is-active $t.timer 2>&1 | head -n 1)"
done
if [ ! -f "$CK/scripts/eng/gitlab-settings.mjs" ]; then
  echo "settings check: not run, $CK has no scripts/eng/gitlab-settings.mjs (run m2.sh install once the milestone 2 files are in GitLab)"
else
  out="$(set -a; . "$ENVF"; set +a; cd "$CK" && node scripts/eng/gitlab-settings.mjs check 2>&1)"; rc=$?
  printf '%s\n' "$out" | grep -E '^(drift|warning|settings check|gitlab-settings|LICENCE)' | cut -c1-300 | head -n 30
  echo "settings check exit: $rc (0 = no drift, 3 = drift, anything else = the check could not run)"
fi
last="$(journalctl -u vitana-settings.service -o cat --no-pager -n 3000 2>/dev/null | grep '"event":"done","exit":0' | tail -n 1 | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p')"
echo "last good settings run: ${last:-none in the journal yet}"
echo "last settings service result: $(systemctl show vitana-settings.service -p Result --value 2>/dev/null)"
REMOTE
}
remote_settings() {
  cat <<'REMOTE'
echo "-- checkout: pull the newest main"
systemctl start vitana-platform-sync.service
echo "checkout sync exit: $?"
echo "-- settings sync"
T="$(date -d '2 seconds ago' '+%Y-%m-%d %H:%M:%S')"
systemctl start vitana-settings.service
rc=$?
journalctl -u vitana-settings.service --since "$T" -o cat --no-pager 2>/dev/null | cut -c1-400 | tail -n 80
echo "settings sync exit: $rc"
exit $rc
REMOTE
}
remote_rehearse() {
  printf 'CK=%q\nENVF=%q\n' "$CHECKOUT" "$HOST_ENV"
  cat <<'REMOTE'
if [ ! -f "$CK/scripts/eng/rehearse.mjs" ]; then
  echo "rehearse: $CK/scripts/eng/rehearse.mjs does not exist. The rehearsal script belongs to the lane 'rehearsal' of plan eng-gitlab-m2 and has not reached this machine. Nothing was run."
  exit 1
fi
set -a; . "$ENVF"; set +a
cd "$CK" && node scripts/eng/rehearse.mjs --project rehearsal --agents 12
rc=$?
echo "rehearse exit: $rc"
exit $rc
REMOTE
}

# ------------------------------------------------------------------ commands
cmd_install() {
  local b64
  [ -f "$HERE/host/ops-install.sh" ] || die "host/ops-install.sh is not next to m2.sh: unzip the folder infra/gitlab-engineering again (RUNBOOK section 2)"
  b64="$(gzip -9 < "$HERE/host/ops-install.sh" | base64 -w0)"
  echo "Installing node, the checkout, the units and the timers on the GitLab machine $GITLAB_ID (a minute or two) ..."
  ssm_run "$GITLAB_ID" "mkdir -p /opt/vitana && echo $b64 | base64 -d | gunzip > /opt/vitana/ops-install.sh && bash /opt/vitana/ops-install.sh" 120
  show_ssm
  if [ "$SSM_STATUS" = Success ]; then echo "install: done"; return 0; fi
  echo "install: FAILED (Systems Manager status $SSM_STATUS). Read the lines above; the log on the machine is /var/log/vitana-bootstrap.log. It is safe to run  bash m2.sh install  again." >&2
  return 1
}

cmd_status() {
  local t state topic alarms subs line proto addr arn name found v ok
  echo "--- GitLab machine $GITLAB_ID"
  ssm_run "$GITLAB_ID" "$(remote_status)" 30
  show_ssm
  if [ "$SSM_STATUS" != Success ]; then problem "the GitLab machine did not answer Systems Manager (status $SSM_STATUS)"; fi
  for t in vitana-platform-sync vitana-settings vitana-land vitana-ci-metrics; do
    grep -q "^timer $t: enabled / active\$" <<<"$SSM_OUT" || problem "the timer $t is not enabled and active (m2.sh install, once the files are in GitLab)"
  done
  grep -q '^settings check exit: 0 ' <<<"$SSM_OUT" || problem "the settings check did not end with exit 0 (3 means GitLab differs from gitlab-settings.json; m2.sh settings corrects it)"
  grep -q '^last good settings run: [0-9]' <<<"$SSM_OUT" || problem "the settings sync has no good run in the journal yet"

  echo "--- alerts and alarms (Terraform outputs of the monitoring lane)"
  state="$(aws s3 cp "s3://vitana-engineering-tfstate-$ACCOUNT_ID/gitlab-engineering/terraform.tfstate" - 2>/dev/null)"
  topic="$(jq -r '.outputs.alerts_topic_arn.value // empty' <<<"$state" 2>/dev/null)"
  alarms="$(jq -r '.outputs.alarm_names.value[]? // empty' <<<"$state" 2>/dev/null)"
  if [ -z "$topic" ] || [ -z "$alarms" ]; then
    problem "the Terraform state has no alerts_topic_arn or alarm_names output yet: run  bash setup.sh  once the monitoring lane is merged"
  else
    subs="$(aws sns list-subscriptions-by-topic --topic-arn "$topic" --query 'Subscriptions[].[Protocol,Endpoint,SubscriptionArn]' --output text 2>/dev/null)"
    if [ -z "$subs" ] || [ "$subs" = None ]; then problem "the alert topic has no subscription: no alarm reaches anyone"; fi
    while IFS=$'\t' read -r proto addr arn; do
      [ -n "${proto:-}" ] || continue
      if [ "$arn" = PendingConfirmation ]; then
        problem "ALERT MAIL NOT CONFIRMED: $addr has not clicked the confirmation link that AWS mailed. No alarm reaches anyone until it does. Look for a mail from AWS Notifications."
      else
        echo "alert subscription $proto $addr: confirmed"
      fi
    done <<<"$subs"
    mapfile -t names <<<"$alarms"
    found="$(aws cloudwatch describe-alarms --alarm-names "${names[@]}" --query 'MetricAlarms[].[AlarmName,StateValue]' --output text 2>/dev/null)"
    for name in "${names[@]}"; do
      line="$(grep -F -- "$name" <<<"$found" | head -n 1)"
      if [ -z "$line" ]; then problem "alarm $name does not exist"; else echo "alarm $name: exists (${line##*$'\t'})"; fi
    done
  fi

  echo "--- fleet runner token"
  v="$(aws secretsmanager get-secret-value --secret-id "$FLEET_TOKEN_SECRET" --query SecretString --output text 2>/dev/null)"
  case "$v" in
    glrt-*) echo "fleet runner token: the secret holds a glrt- value" ;;
    ""|None) problem "fleet runner token: the secret is empty; the settings sync fills it once it has created the runner" ;;
    *) problem "fleet runner token: the secret holds a value that is not a glrt- runner token" ;;
  esac
  v=""
  ok=0
  [ "$PROBLEMS" = 0 ] && ok=1
  if [ "$ok" = 1 ]; then echo "status: all good"; return 0; fi
  echo "status: $PROBLEMS thing(s) need attention (marked !! above)"
  return 1
}

cmd_settings() {
  echo "Pulling the newest main and running the settings sync on the GitLab machine $GITLAB_ID ..."
  ssm_run "$GITLAB_ID" "$(remote_settings)" 100
  show_ssm
  if [ "$SSM_STATUS" = Success ]; then echo "settings: the sync finished with exit 0"; return 0; fi
  echo "settings: the sync did NOT finish well (Systems Manager status $SSM_STATUS). The JSON lines above name the step." >&2
  return 1
}

cmd_rehearse() {
  echo "Running the rehearsal (12 agents) on the GitLab machine $GITLAB_ID. This can take an hour; if CloudShell closes, the machine keeps working."
  SSM_EXEC_TIMEOUT=7200 ssm_run "$GITLAB_ID" "$(remote_rehearse)" 1440
  [ -z "$SSM_CID" ] || echo "command id: $SSM_CID  (read the report later with: aws ssm get-command-invocation --command-id $SSM_CID --instance-id $GITLAB_ID --query StandardOutputContent --output text)"
  show_ssm
  if [ "$SSM_STATUS" = Success ]; then echo "rehearse: finished"; return 0; fi
  echo "rehearse: did NOT finish well (Systems Manager status $SSM_STATUS)." >&2
  return 1
}

case "${1:-}" in
  install|status|settings|rehearse) ;;
  -h|--help|help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
connect
"cmd_$1"
