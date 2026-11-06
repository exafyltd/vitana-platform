#!/usr/bin/env bash
# Mutation check for scripts/eng/monitoring-structure.test.mjs and scripts/eng/ci-metrics.test.mjs (VTID-05539, lane eng-gitlab-m2/monitoring).
# One property of the lane is broken at a time in a scratch copy, and the two test files (run together) must go red. A mutation counts
# as caught only when
#   - the mutated file still parses as what it is (node --check, bash -n, the Terraform formatter's parser, an ini line check), and
#   - at least one test case fails by name (a crash of a whole test file before any case runs is CRASH, a run cut by the timeout HUNG).
# A mutation that changes nothing (NOOP), whose old text is not unique (AMBIGUOUS, run_str only), that breaks the syntax by accident
# (INVALID) or that leaves every test green (SURVIVED) is reported as not caught: it proves nothing, or it shows a property no test pins.
#
# usage: mutate-monitoring.sh <worktree of the lane>
# env:   TERRAFORM  path of the terraform binary (default: terraform)
#        TMPDIR     where the scratch copies go (default /tmp)
#        ONLY       regex on the mutation name: run a subset
#        COUNT_ONLY=1  only check that every run_str old text is found exactly once (no test is run)
#        PART=i/n   run only every n-th mutation, starting at i (0-based): n runs in parallel share the work
set -u
SRC="${1:?worktree}"
TF="${TERRAFORM:-terraform}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mutmon-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
TESTS="scripts/eng/monitoring-structure.test.mjs scripts/eng/ci-metrics.test.mjs"
total=0; bad=0; idx=0
PART="${PART:-}"   # i/n: run only the mutations whose number modulo n is i (0-based), so that n runs can share the work

selected() {   # false when PART excludes the next mutation
  idx=$((idx + 1))
  [ -z "$PART" ] && return 0
  [ $((idx % ${PART#*/})) = "${PART%/*}" ]
}

command -v "$TF" >/dev/null || { echo "terraform not found (set TERRAFORM): the .tf guard cannot run"; exit 2; }

prepare() {   # a fresh scratch tree with everything the two test files read
  rm -rf "$WORK/t"
  mkdir -p "$WORK/t/scripts/eng/testing" "$WORK/t/infra" "$WORK/t/.kiro/specs/eng-gitlab-m2"
  cp -r "$SRC/infra/gitlab-engineering" "$WORK/t/infra/"
  cp "$SRC"/scripts/eng/gitlab-api.mjs "$SRC"/scripts/eng/ci-metrics.mjs "$SRC"/scripts/eng/ci-metrics.test.mjs "$SRC"/scripts/eng/monitoring-structure.test.mjs "$WORK/t/scripts/eng/"
  cp "$SRC/scripts/eng/testing/fake-fetch.mjs" "$WORK/t/scripts/eng/testing/"
  cp "$SRC/.kiro/specs/eng-gitlab-m2/tasks.md" "$WORK/t/.kiro/specs/eng-gitlab-m2/"
}

parses() {   # file -> exit 0 when the file still parses as its extension says
  case "$1" in
    *.sh)            bash -n "$1" 2>/dev/null ;;
    *.mjs)           node --check "$1" 2>/dev/null ;;
    *.tf)            "$TF" fmt -list=false -write=false "$1" >/dev/null 2>&1 ;;   # exit 2 on a syntax error, 0 otherwise
    *.service|*.timer) python3 -c '
import re, sys
for line in open(sys.argv[1], encoding="utf8"):
    s = line.rstrip("\n")
    if s.strip() == "" or s.lstrip().startswith("#"): continue
    if not (re.fullmatch(r"\[[A-Za-z]+\]", s) or re.fullmatch(r"[A-Za-z]+=.*", s)): sys.exit(1)
' "$1" ;;
    *)               return 0 ;;
  esac
}

# The unmutated tree must pass, or every "caught" below would be meaningless.
if [ -z "${COUNT_ONLY:-}" ]; then
  prepare
  base="$(cd "$WORK/t" && node --test $TESTS 2>&1)"
  if ! grep -q '^# fail 0' <<<"$base"; then echo "baseline: the tests fail on the unmutated tree"; grep -E '^not ok' <<<"$base" | head; exit 2; fi
  echo "baseline: $(grep -E '^# tests ' <<<"$base" | cut -c3-) and $(grep -E '^# pass ' <<<"$base" | cut -c3-) on the unmutated tree"
fi

judge() {   # name, file (relative to the scratch root)
  local name="$1" f="$WORK/t/$2" out rc failed names
  if ! parses "$f"; then echo "INVALID     $name (the mutated file does not parse: it proves nothing)"; bad=$((bad + 1)); return; fi
  out="$(cd "$WORK/t" && timeout 180 node --test $TESTS 2>&1)"; rc=$?
  names="$(grep -E '^not ok' <<<"$out" | sed -E 's/^not ok [0-9]+ - //')"
  failed="$(cut -c1-70 <<<"$names" | head -2 | paste -sd'|' -)"
  if [ "$rc" = 124 ]; then echo "HUNG        $name"; bad=$((bad + 1))
  elif [ -z "$names" ] && [ "$rc" = 0 ]; then echo "SURVIVED    $name"; bad=$((bad + 1))
  elif ! grep -vqE '\.test\.mjs$' <<<"$names"; then echo "CRASH       $name (a test file crashed before running a case: $failed)"; bad=$((bad + 1))
  else echo "caught      $name  <- $failed"; fi
}

run_mut() {   # name, file, perl expression (for the changes that are easier to say as a pattern)
  local name="$1" file="$2" expr="$3"
  if [ -n "${ONLY:-}" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  selected || return
  [ -n "${COUNT_ONLY:-}" ] && return
  prepare
  local f="$WORK/t/$file" before after
  before="$(sha256sum "$f" | cut -c1-16)"
  perl -0pi -e "$expr" "$f"
  after="$(sha256sum "$f" | cut -c1-16)"
  total=$((total + 1))
  if [ "$before" = "$after" ]; then echo "NOOP        $name (the mutation changed nothing: fix the mutation)"; bad=$((bad + 1)); return; fi
  judge "$name" "$file"
}

run_str() {   # name, file, old text, new text: the old text must be found exactly once
  local name="$1" file="$2"
  if [ -n "${ONLY:-}" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  selected || return
  prepare
  local f="$WORK/t/$file" n
  n="$(OLD="$3" perl -0777 -ne 'my $c = () = /\Q$ENV{OLD}\E/g; print $c' "$f")"
  total=$((total + 1))
  if [ "$n" != 1 ]; then echo "$([ "$n" = 0 ] && echo NOOP || echo AMBIGUOUS)        $name (old text found $n times in $file)"; bad=$((bad + 1)); return; fi
  [ -n "${COUNT_ONLY:-}" ] && return
  OLD="$3" NEW="$4" perl -0777 -pi -e 's/\Q$ENV{OLD}\E/$ENV{NEW}/' "$f"
  judge "$name" "$file"
}

# alarm A of resource R: change the value of attribute ATTR from OLD to NEW (all attribute values are single-line)
alarm() { run_mut "$1" "$M" "s/(resource \"aws_cloudwatch_metric_alarm\" \"$2\".*?\\n\\s*$3\\s*=\\s*)$4(\\s*\\n)/\${1}$5\${2}/s"; }

M=infra/gitlab-engineering/terraform/monitoring.tf
S=infra/gitlab-engineering/host/units/vitana-ci-metrics.service
T=infra/gitlab-engineering/host/units/vitana-ci-metrics.timer
C=infra/gitlab-engineering/host/ops.d/20-cwagent.sh
J=scripts/eng/ci-metrics.mjs

# ================================================================== monitoring.tf: the alarms of plan section 3.6
alarm "oldest pending job: threshold 20 min"           oldest_pending_job threshold 600 1200
alarm "oldest pending job: period 5 min"               oldest_pending_job period 60 300
alarm "oldest pending job: fires on one datapoint"     oldest_pending_job datapoints_to_alarm 3 1
alarm "oldest pending job: one evaluation period"      oldest_pending_job evaluation_periods 3 1
alarm "oldest pending job: missing data breaches"      oldest_pending_job treat_missing_data '"notBreaching"' '"breaching"'
alarm "oldest pending job: reads the pending count"    oldest_pending_job metric_name '"OldestPendingJobAgeSeconds"' '"PendingJobs"'
alarm "oldest pending job: average, not maximum"       oldest_pending_job statistic '"Maximum"' '"Average"'
alarm "oldest pending job: fires below the threshold"  oldest_pending_job comparison_operator '"GreaterThanThreshold"' '"LessThanThreshold"'
alarm "oldest pending job: tells nobody"               oldest_pending_job alarm_actions '\[aws_sns_topic\.alerts\.arn\]' '[]'
alarm "fleet at maximum: threshold hard-coded"         fleet_at_maximum threshold 'var\.fleet_alarm_running_jobs' 12
alarm "fleet at maximum: 10 minutes, not 30"           fleet_at_maximum evaluation_periods 30 10
alarm "fleet at maximum: one datapoint is enough"      fleet_at_maximum datapoints_to_alarm 30 1
alarm "fleet at maximum: missing data breaches"        fleet_at_maximum treat_missing_data '"notBreaching"' '"breaching"'
alarm "fleet at maximum: maximum, not minimum"         fleet_at_maximum statistic '"Minimum"' '"Maximum"'
alarm "fleet at maximum: strictly greater"             fleet_at_maximum comparison_operator '"GreaterThanOrEqualToThreshold"' '"GreaterThanThreshold"'
alarm "fleet at maximum: other metric"                 fleet_at_maximum metric_name '"FleetRunningJobs"' '"RunningJobs"'
alarm "host status: missing data does not breach"      gitlab_host_status treat_missing_data '"breaching"' '"notBreaching"'
alarm "host status: threshold 1"                       gitlab_host_status threshold 0 1
alarm "host status: another service namespace"         gitlab_host_status namespace '"AWS\/EC2"' '"AWS\/RDS"'
alarm "host status: system check only"                 gitlab_host_status metric_name '"StatusCheckFailed"' '"StatusCheckFailed_System"'
alarm "host status: 1 of 1 minute"                     gitlab_host_status evaluation_periods 5 1
alarm "disk: threshold 90"                             gitlab_disk_used threshold 80 90
alarm "disk: reads free space"                         gitlab_disk_used metric_name '"disk_used_percent"' '"disk_free"'
alarm "disk: missing data breaches"                    gitlab_disk_used treat_missing_data '"notBreaching"' '"breaching"'
alarm "disk: period 1 min"                             gitlab_disk_used period 300 60
alarm "load balancer: healthy count"                   gitlab_lb_unhealthy_target metric_name '"UnHealthyHostCount"' '"HealthyHostCount"'
alarm "load balancer: fires on fewer than 1"           gitlab_lb_unhealthy_target comparison_operator '"GreaterThanThreshold"' '"LessThanThreshold"'
alarm "load balancer: missing data breaches"           gitlab_lb_unhealthy_target treat_missing_data '"notBreaching"' '"breaching"'
run_mut "load balancer: target group dimension dropped" $M 's/(resource "aws_cloudwatch_metric_alarm" "gitlab_lb_unhealthy_target".*?)\n\s*TargetGroup\s*=\s*aws_lb_target_group\.gitlab\.arn_suffix/${1}/s'
alarm "backup: 24 h, not 30"                           backup_age threshold 108000 86400
alarm "backup: missing data does not breach"           backup_age treat_missing_data '"breaching"' '"notBreaching"'
alarm "backup: another metric"                         backup_age metric_name '"BackupAgeSeconds"' '"TickAgeSeconds"'
alarm "backup: below the threshold"                    backup_age comparison_operator '"GreaterThanThreshold"' '"LessThanThreshold"'
alarm "merge bot: 30 minutes"                          merge_bot_tick threshold 900 1800
alarm "merge bot: watches the settings sync"           merge_bot_tick 'Unit' '"vitana-land"' '"vitana-settings"'
alarm "merge bot: missing data does not breach"        merge_bot_tick treat_missing_data '"breaching"' '"notBreaching"'
alarm "merge bot: fires on one datapoint"              merge_bot_tick datapoints_to_alarm 3 1
alarm "settings sync: 5 minutes"                       settings_sync_tick threshold 900 300
alarm "settings sync: watches the merge bot"           settings_sync_tick 'Unit' '"vitana-settings"' '"vitana-land"'
alarm "settings sync: missing data does not breach"    settings_sync_tick treat_missing_data '"breaching"' '"notBreaching"'
alarm "settings sync: wrong unit name"                 settings_sync_tick 'Unit' '"vitana-settings"' '"vitana-platform-sync"'
run_mut "alarm renamed"                                $M 's/alarm_name(\s*)=(\s*)"vitana-eng-backup-age"/alarm_name${1}=${2}"vitana-eng-backup"/'
run_mut "alarm resource renamed (one of eight gone)"   $M 's/resource "aws_cloudwatch_metric_alarm" "backup_age"/resource "aws_cloudwatch_metric_alarm" "backup_age_old"/'
run_mut "a ninth alarm"                                $M 's/(# -+ the budget)/resource "aws_cloudwatch_metric_alarm" "extra" {\n  alarm_name = "x"\n  namespace = "AWS\/EC2"\n  metric_name = "CPUUtilization"\n  statistic = "Average"\n  comparison_operator = "GreaterThanThreshold"\n  threshold = 1\n  period = 60\n  evaluation_periods = 1\n  alarm_actions = [aws_sns_topic.alerts.arn]\n}\n\n${1}/'
run_mut "an alarm also mails on recovery"              $M 's/(resource "aws_cloudwatch_metric_alarm" "backup_age".*?alarm_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\])/${1}\n  ok_actions = [aws_sns_topic.alerts.arn]/s'
run_mut "an alarm is switched off"                     $M 's/(resource "aws_cloudwatch_metric_alarm" "backup_age".*?alarm_actions\s*=\s*\[aws_sns_topic\.alerts\.arn\])/${1}\n  actions_enabled = false/s'
run_mut "namespace of the queue alarms changed"        $M 's/monitoring_namespace\s*=\s*"Vitana\/Engineering"/monitoring_namespace = "Vitana\/Eng"/'
run_mut "alarm description emptied"                    $M 's/(resource "aws_cloudwatch_metric_alarm" "backup_age".*?alarm_description\s*=\s*)"[^"\n]*"/${1}"short"/s'

# ================================================================== monitoring.tf: topic, key, subscription
run_str "topic renamed"                                $M 'name              = "vitana-eng-alerts"' 'name              = "vitana-eng-alert"'
run_str "topic uses the key of milestone 1"            $M 'kms_master_key_id = aws_kms_key.alerts.arn' 'kms_master_key_id = aws_kms_key.main.arn'
run_str "topic uses the AWS managed SNS key"           $M 'kms_master_key_id = aws_kms_key.alerts.arn' 'kms_master_key_id = "alias/aws/sns"'
run_str "topic is not encrypted"                       $M $'  kms_master_key_id = aws_kms_key.alerts.arn\n' ''
run_str "key rotation off"                             $M 'enable_key_rotation     = true' 'enable_key_rotation     = false'
run_str "key deletion window 7 days"                   $M 'deletion_window_in_days = 30' 'deletion_window_in_days = 7'
run_str "key without its policy"                       $M $'  policy                  = data.aws_iam_policy_document.alerts_key.json\n' ''
run_str "key alias renamed"                            $M 'name          = "alias/vitana-engineering-alerts"' 'name          = "alias/vitana-alerts"'
run_str "key policy names events, not cloudwatch"      $M 'identifiers = ["cloudwatch.amazonaws.com"]' 'identifiers = ["events.amazonaws.com"]'
run_str "key policy: no data key for CloudWatch"       $M 'actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]' 'actions   = ["kms:Decrypt"]'
run_str "key policy: CloudWatch may administer"        $M 'actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]' 'actions   = ["kms:*"]'
run_str "key policy: any account's alarms"             $M 'variable = "aws:SourceAccount"' 'variable = "aws:SourceOrgID"'
run_str "key policy: any alarm ARN"                    $M ':alarm:*"]' ':*"]'
run_str "key policy: root statement renamed away"      $M 'sid       = "EnableIamPolicies"' 'sid       = "EnableIam"'
run_str "key policy: root principal is everyone"       $M 'identifiers = ["arn:aws:iam::${data.aws_caller_identity.me.account_id}:root"]' 'identifiers = ["*"]'
run_str "subscription protocol sms"                    $M 'protocol  = "email"' 'protocol  = "sms"'
run_str "subscription goes to alert_email only"        $M 'endpoint  = local.monitoring_alert_email' 'endpoint  = var.alert_email'
run_str "recipient does not fall back to admin_email"  $M 'trimspace(var.alert_email != "" ? var.alert_email : var.admin_email)' 'trimspace(var.alert_email)'
run_str "address check dropped"                        $M 'condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+$", local.monitoring_alert_email))' 'condition     = true'
run_mut "subscription precondition removed"            $M 's/\n  lifecycle \{\n    precondition \{.*?\n    \}\n  \}\n/\n/s'

# ================================================================== monitoring.tf: budget
run_mut "budget 50 percent becomes 60"                 $M 's/(notification \{[^}]*?threshold\s*=\s*)50\b/${1}60/s'
run_mut "budget 80 percent becomes 90"                 $M 's/(threshold\s*=\s*)80(\s*\n\s*threshold_type)/${1}90${2}/'
run_mut "budget 100 percent becomes 110"               $M 's/(threshold\s*=\s*)100(\s*\n\s*threshold_type)/${1}110${2}/'
run_mut "budget third notification dropped"            $M 's/\n  notification \{[^}]*?threshold\s*=\s*100\b[^}]*?\}\n/\n/s'
run_str "budget yearly"                                $M 'time_unit    = "MONTHLY"' 'time_unit    = "ANNUALLY"'
run_str "budget in euro"                               $M 'limit_unit   = "USD"' 'limit_unit   = "EUR"'
run_str "budget by usage"                              $M 'budget_type  = "COST"' 'budget_type  = "USAGE"'
run_str "budget amount fixed"                          $M 'limit_amount = tostring(var.monthly_budget_usd)' 'limit_amount = "1000"'
run_str "budget renamed"                               $M 'name         = "vitana-eng-monthly"' 'name         = "vitana-eng-budget"'
run_mut "budget mails on the forecast"                 $M 's/(threshold\s*=\s*)80(\s*\n\s*threshold_type\s*=\s*"PERCENTAGE"\s*\n\s*notification_type\s*=\s*)"ACTUAL"/${1}80${2}"FORECASTED"/'
run_mut "budget notifies the topic as well"            $M 's/(subscriber_email_addresses\s*=\s*\[local\.monitoring_alert_email\])(\s*\n  \}\n\n  notification \{\n    comparison_operator\s*=\s*"GREATER_THAN"\n    threshold\s*=\s*80)/${1}\n    subscriber_sns_topic_arns = [aws_sns_topic.alerts.arn]${2}/'
run_str "budget mails someone else"                    $M $'    threshold                  = 100\n    threshold_type             = "PERCENTAGE"\n    notification_type          = "ACTUAL"\n    subscriber_email_addresses = [local.monitoring_alert_email]' $'    threshold                  = 100\n    threshold_type             = "PERCENTAGE"\n    notification_type          = "ACTUAL"\n    subscriber_email_addresses = ["nobody@example.test"]'

# ================================================================== monitoring.tf: host role, variables, outputs
run_str "metrics permission is wider than PutMetricData" $M 'actions   = ["cloudwatch:PutMetricData"]' 'actions   = ["cloudwatch:*"]'
run_str "metrics permission loses its namespace limit"   $M 'variable = "cloudwatch:namespace"' 'variable = "aws:RequestedRegion"'
run_str "metrics permission for every namespace"         $M 'values   = [local.monitoring_namespace]' 'values   = ["*"]'
run_str "metrics permission is also a read"              $M 'actions   = ["cloudwatch:PutMetricData"]' 'actions   = ["cloudwatch:PutMetricData", "cloudwatch:GetMetricData"]'
run_str "metrics permission on the runner role"          $M 'role   = aws_iam_role.gitlab.id' 'role   = aws_iam_role.runner.id'
run_str "metrics policy renamed"                         $M 'name   = "monitoring"' 'name   = "metrics"'
run_str "variable alert_email loses its default"         $M $'  type        = string\n  default     = ""\n' $'  type        = string\n'
run_str "budget default 500"                             $M 'default     = 1000' 'default     = 500'
run_str "fleet default 12"                               $M 'default     = 24' 'default     = 12'
run_mut "variable declared twice"                        $M 's/(# -+ the topic)/variable "region" {\n  type = string\n  default = "x"\n}\n\n${1}/'
run_mut "a provider block"                               $M 's/(# -+ the topic)/provider "aws" {\n  region = "us-east-1"\n}\n\n${1}/'
run_mut "an inline JSON policy"                          $M 's/policy\s*=\s*data\.aws_iam_policy_document\.monitoring\.json/policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "cloudwatch:PutMetricData", Resource = "*" }] })/'
run_mut "an output without the topic"                    $M 's/output "alerts_topic_arn" \{\n  value = aws_sns_topic\.alerts\.arn\n\}\n\n//'
run_mut "an output without the settings alarm"           $M 's/\n    aws_cloudwatch_metric_alarm\.settings_sync_tick\.alarm_name,//'
run_mut "output names the wrong email"                   $M 's/value = local\.monitoring_alert_email/value = var.alert_email/'

# ================================================================== the units
run_str "service is not a one-shot"                   $S 'Type=oneshot' 'Type=simple'
run_str "service without -n"                          $S '/usr/bin/flock -n -E 0 ' '/usr/bin/flock -E 0 '
run_str "service exits 1 on a busy lock"              $S 'flock -n -E 0 ' 'flock -n -E 1 '
run_str "service has no lock"                         $S '/usr/bin/flock -n -E 0 /run/vitana-ci-metrics.lock /usr/bin/node' '/usr/bin/node'
run_str "service reads another token file"            $S '--token-file /etc/vitana/bot-metrics-token' '--token-file /etc/vitana/bot-land-token'
run_str "service keeps state elsewhere"               $S '--state-dir /var/lib/vitana-ci-metrics' '--state-dir /var/lib/other'
run_str "service asks another GitLab"                 $S '--url http://127.0.0.1' '--url https://gitlab.example.test'
run_str "service runs another script"                 $S 'scripts/eng/ci-metrics.mjs' 'scripts/eng/gitlab-land.mjs'
run_str "service is not niced"                        $S $'Nice=10\n' ''
run_str "service without a CPU cap"                   $S $'CPUQuota=50%\n' ''
run_str "service without a memory cap"                $S $'MemoryMax=512M\n' ''
run_str "service may run 20 minutes"                  $S 'TimeoutStartSec=90' 'TimeoutStartSec=1200'
run_str "service without the environment file"        $S $'EnvironmentFile=/etc/vitana/env\n' ''
run_str "service without a state directory"           $S $'StateDirectory=vitana-ci-metrics\n' ''
run_str "service may gain privileges"                 $S 'NoNewPrivileges=true' 'NoNewPrivileges=false'
run_str "service sees the real tmp"                   $S 'PrivateTmp=true' 'PrivateTmp=false'
run_str "service may write the whole system"          $S 'ProtectSystem=full' 'ProtectSystem=no'
run_str "service sees home directories"               $S 'ProtectHome=true' 'ProtectHome=false'
run_str "service without a home for the CLI"          $S $'Environment=HOME=/var/lib/vitana-ci-metrics\n' ''
run_str "service carries a token"                     $S $'StateDirectory=vitana-ci-metrics\n' $'StateDirectory=vitana-ci-metrics\nEnvironment=PRIVATE-TOKEN=a-value-for-the-mutation\n'
run_str "service runs as a user without the token file" $S $'[Service]\nType=oneshot\n' $'[Service]\nUser=nobody\nType=oneshot\n'
run_str "service starts before the network"           $S 'After=network-online.target' 'After=basic.target'
run_str "timer every 5 minutes"                       $T 'OnUnitActiveSec=1min' 'OnUnitActiveSec=5min'
run_str "timer starts after 20 minutes"               $T 'OnBootSec=2min' 'OnBootSec=20min'
run_str "timer with a 1 h accuracy"                   $T 'AccuracySec=5s' 'AccuracySec=1h'
run_str "timer starts another unit"                   $T 'Unit=vitana-ci-metrics.service' 'Unit=vitana-land.service'
run_str "timer not installed anywhere"                $T 'WantedBy=timers.target' 'WantedBy=multi-user.target'

# ================================================================== the CloudWatch agent script
run_str "fingerprint differs by one character"        $C 'KEY_FPR="937616F3450B7D806CBD9725D58167303B789C72"' 'KEY_FPR="937616F3450B7D806CBD9725D58167303B789C73"'
run_str "fingerprint check inverted"                  $C 'if [ "$got" != "$KEY_FPR" ]; then' 'if [ "$got" = "$KEY_FPR" ]; then'
run_str "signature not verified"                      $C 'gpg --batch --verify "$tmp/agent.deb.sig" "$tmp/agent.deb"' 'true'
run_str "package installed with --force-all"          $C 'dpkg -i "$tmp/agent.deb"' 'dpkg -i --force-all "$tmp/agent.deb"'
run_str "script not strict"                           $C 'set -euo pipefail' 'set -uo pipefail'
run_str "script traces its commands"                  $C 'set -euo pipefail' 'set -euxo pipefail'
run_str "curl ignores an HTTP error (package)"        $C 'curl -fsSL --retry 3 -o "$tmp/agent.deb" "$PKG_URL"' 'curl -sSL --retry 3 -o "$tmp/agent.deb" "$PKG_URL"'
run_str "package over plain http"                     $C 'PKG_URL="https://' 'PKG_URL="http://'
run_str "key over plain http"                         $C 'KEY_URL="https://' 'KEY_URL="http://'
run_str "package from another path"                   $C '/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb"' '/ubuntu/arm64/latest/amazon-cloudwatch-agent.deb"'
run_str "no signature downloaded"                     $C 'curl -fsSL --retry 3 -o "$tmp/agent.deb.sig" "$PKG_URL.sig"' 'true'
run_str "installs again every run"                    $C 'if dpkg -s amazon-cloudwatch-agent >/dev/null 2>&1; then' 'if false; then'
run_str "download directory left behind"              $C $'  trap \'rm -rf "$tmp"\' EXIT\n' ''
run_str "configuration always rewritten"              $C 'if [ -f "$CONFIG" ] && cmp -s "$CONFIG.new" "$CONFIG"; then' 'if false; then'
run_str "agent always restarted"                      $C 'if [ "$changed" = 1 ] || ! systemctl is-active --quiet amazon-cloudwatch-agent; then' 'if true; then'
run_str "agent only started when the file changed"    $C 'if [ "$changed" = 1 ] || ! systemctl is-active --quiet amazon-cloudwatch-agent; then' 'if [ "$changed" = 1 ]; then'
run_str "agent configured for on-premises"            $C '-a fetch-config -m ec2 -c file:' '-a fetch-config -m onPremise -c file:'
run_str "agent not started after configuring"         $C '-c file:"$CONFIG" -s' '-c file:"$CONFIG"'
run_str "agent not enabled at boot"                   $C $'  systemctl enable amazon-cloudwatch-agent\n' ''
run_str "a stopped agent is not an error"             $C $'    echo "cwagent: the CloudWatch agent is not running after it was started; see /opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log" >&2\n    exit 1\n' $'    echo "not running"\n'
run_str "agent namespace changed"                     $C '"namespace": "Vitana/Engineering"' '"namespace": "CWAgent"'
run_str "agent loses the InstanceId dimension"        $C '"InstanceId": "${aws:InstanceId}"' '"ImageId": "${aws:ImageId}"'
run_str "agent rolls up on another dimension"         $C '"aggregation_dimensions": [["InstanceId"]],' '"aggregation_dimensions": [["InstanceId", "path"]],'
run_str "agent keeps the device dimension"            $C '"drop_device": true,' '"drop_device": false,'
run_str "agent measures every mount"                  $C '"resources": ["/"],' '"resources": ["*"],'
run_str "agent measures free space"                   $C '"measurement": ["used_percent"],' '"measurement": ["free"],'
run_str "agent collects every ten seconds"            $C '"metrics_collection_interval": 60
      }' '"metrics_collection_interval": 10
      }'

# ================================================================== ci-metrics.mjs: names and constants
run_str "namespace changed"                           $J "export const NAMESPACE = 'Vitana/Engineering';" "export const NAMESPACE = 'Vitana/Eng';"
run_str "pending metric renamed"                      $J "pendingJobs: 'PendingJobs'," "pendingJobs: 'Pending',"
run_str "oldest age metric renamed"                   $J "oldestPendingJobAge: 'OldestPendingJobAgeSeconds'," "oldestPendingJobAge: 'OldestPendingAge',"
run_str "failure metric renamed"                      $J "gitlabReadFailed: 'GitLabReadFailed'," "gitlabReadFailed: 'GitLabFailed',"
run_str "tick metric renamed"                         $J "tickAge: 'TickAgeSeconds'," "tickAge: 'TickAge',"
run_str "backup metric renamed"                       $J "backupAge: 'BackupAgeSeconds'," "backupAge: 'BackupAge',"
run_str "fleet metric renamed"                        $J "fleetRunningJobs: 'FleetRunningJobs'," "fleetRunningJobs: 'FleetJobs',"
run_str "settings unit renamed"                       $J "Object.freeze(['vitana-land', 'vitana-settings'])" "Object.freeze(['vitana-land', 'vitana-sync'])"
run_str "fleet tag changed"                           $J "export const FLEET_TAG = 'vitana-eng';" "export const FLEET_TAG = 'vitana-legacy';"
run_str "backup prefix changed"                       $J "export const BACKUP_PREFIX = 'backups/';" "export const BACKUP_PREFIX = '';"
run_str "default token file changed"                  $J "tokenFile: '/etc/vitana/bot-metrics-token'," "tokenFile: '/etc/vitana/bot-land-token',"
run_str "default state directory changed"             $J "stateDir: '/var/lib/vitana-ci-metrics'," "stateDir: '/var/lib/ci-metrics',"
run_str "default GitLab deadline 4 minutes"           $J "gitlabDeadlineMs: 40_000," "gitlabDeadlineMs: 240_000,"
run_str "default request timeout changed"             $J "requestTimeoutMs: 15_000," "requestTimeoutMs: 1_500,"

# ================================================================== ci-metrics.mjs: the job queue
run_str "archived projects included"                  $J "archived: false, simple: true" "archived: true, simple: true"
run_str "not only the account's projects"             $J "membership: true, archived" "membership: false, archived"
run_str "pending jobs not asked for"                  $J "const JOB_SCOPES = ['pending', 'preparing', 'running'];" "const JOB_SCOPES = ['preparing', 'running'];"
run_str "running jobs not asked for"                  $J "const JOB_SCOPES = ['pending', 'preparing', 'running'];" "const JOB_SCOPES = ['pending', 'preparing'];"
run_str "preparing jobs not counted as running"       $J "job?.status === 'running' || job?.status === 'preparing'" "job?.status === 'running'"
run_str "every running job counts for the fleet"      $J "if (Array.isArray(job.tag_list) && job.tag_list.includes(FLEET_TAG)) fleetRunningJobs++;" "fleetRunningJobs++;"
run_str "an empty account is an empty queue"          $J "if (projects.length === 0) throw" "if (false) throw"
run_str "no readable project is an empty queue"       $J "if (readable === 0) throw" "if (false) throw"
run_str "a forbidden project fails the read"          $J "if (err instanceof GitLabApiError && (err.status === 403 || err.status === 404)) {
        log({ event: 'project_skipped'" "if (false) {
        log({ event: 'project_skipped'"
run_str "a 500 on a project is skipped like a 403"    $J "if (err instanceof GitLabApiError && (err.status === 403 || err.status === 404)) {
        log({ event: 'project_skipped'" "if (err instanceof GitLabApiError) {
        log({ event: 'project_skipped'"
run_str "the youngest job is the oldest"              $J "oldest = oldest === null ? age : Math.max(oldest, age);" "oldest = oldest === null ? age : Math.min(oldest, age);"
run_str "running pipelines are aged from creation"    $J "pipeline.status !== 'pending') {" "false) {"
run_str "pending pipelines are looked up too"         $J "pipeline.status !== 'pending') {" "true) {"
run_str "the last finish is ignored"                  $J "if (finished !== null) sinceMs = Math.max(sinceMs, finished);" "if (finished !== null) sinceMs = sinceMs;"
run_str "the oldest finish, not the newest"           $J "latest = latest === null ? t : Math.max(latest, t);" "latest = latest === null ? t : Math.min(latest, t);"
run_str "pipeline looked up once per job"             $J "lookups.set(key, finished);
      }" "}"
run_str "no cap on pipeline lookups"                  $J "if (made >= maxPipelineLookups) {" "if (false) {"
run_str "cap one too late"                            $J "if (made >= maxPipelineLookups) {" "if (made > maxPipelineLookups) {"
run_str "a skipped pipeline is aged from creation"    $J "if (finished === SKIPPED) continue;" "if (finished === SKIPPED) finished = null;"
run_str "the newest pending jobs are looked up first" $J "datable.sort((a, b) => a.createdMs - b.createdMs);" "datable.sort((a, b) => b.createdMs - a.createdMs);"
run_str "an undatable job is aged as 0"               $J "if (Number.isFinite(w.createdMs)) datable.push(w);" "if (true) datable.push({ ...w, createdMs: Number.isFinite(w.createdMs) ? w.createdMs : now });"
run_str "a job in the future gives a negative age"    $J "const seconds = (fromMs, toMs) => Math.max(0, Math.floor((toMs - fromMs) / 1000));" "const seconds = (fromMs, toMs) => Math.floor((toMs - fromMs) / 1000);"
run_str "ages are rounded up"                         $J "const seconds = (fromMs, toMs) => Math.max(0, Math.floor((toMs - fromMs) / 1000));" "const seconds = (fromMs, toMs) => Math.max(0, Math.ceil((toMs - fromMs) / 1000));"
run_str "an empty queue is not a zero"                $J "const oldestPendingJobAgeSeconds = pendingJobs === 0 ? 0 : await" "const oldestPendingJobAgeSeconds = pendingJobs === 0 ? null : await"
run_str "an unageable queue is a zero"                $J "return oldest;
}" "return oldest ?? 0;
}"
run_str "a vanished pipeline fails the read"          $J "if (err instanceof GitLabApiError && (err.status === 403 || err.status === 404)) {
      log({ event: 'pipeline_lookup_skipped'" "if (false) {
      log({ event: 'pipeline_lookup_skipped'"

# ================================================================== ci-metrics.mjs: ticks and state
run_str "a failed run counts as a good tick"          $J "p.ActiveState === 'inactive' && p.Result === 'success' &&" "p.ActiveState === 'inactive' &&"
run_str "a running unit counts as a good tick"        $J "p.ActiveState === 'inactive' && p.Result === 'success' &&" "p.Result === 'success' &&"
run_str "an older observation replaces a newer tick"  $J "const best = observedMs !== null && stored !== null ? Math.max(observedMs, stored) : observedMs ?? stored;" "const best = observedMs ?? stored;"
run_str "the stored tick is ignored"                  $J "const best = observedMs !== null && stored !== null ? Math.max(observedMs, stored) : observedMs ?? stored;" "const best = observedMs;"
run_str "an unknown unit is a zero"                   $J "if (best === null) {
      log({ event: 'tick_unknown', unit });
      continue;
    }" "if (best === null) {
      log({ event: 'tick_unknown', unit });
      ticks.push({ unit, ageSeconds: 0 });
      continue;
    }"
run_str "a never-started unit is a good tick"         $J "Number.isFinite(mono) && mono > 0) {" "Number.isFinite(mono)) {"
run_str "uptime and monotonic clock mixed up"         $J "const agoSeconds = uptimeSeconds - mono / 1e6;" "const agoSeconds = mono / 1e6 - uptimeSeconds;"
run_str "the wrong unit is asked"                     $J "['show', \`\${unit}.service\`," "['show', \`\${unit}.timer\`,"
run_str "state of another version accepted"           $J "const map = parsed?.version === 1 ? parsed.lastSuccessMs : null;" "const map = parsed?.lastSuccessMs ?? null;"
run_str "a non-numeric stored time accepted"          $J "const stored = isNumber(state[unit]) && state[unit] > 0 ? state[unit] : null;" "const stored = state[unit] ?? null;"
run_str "state never saved"                           $J "  await saveState(options.stateDir, state, log);
" ""
run_str "state saved in a dry run"                    $J "  if (options.dryRun) {
    log({ event: 'dry_run', metrics: data });
    return { exitCode: 0 };
  }
  await saveState(options.stateDir, state, log);" "  await saveState(options.stateDir, state, log);
  if (options.dryRun) {
    log({ event: 'dry_run', metrics: data });
    return { exitCode: 0 };
  }"
run_str "state file written without a rename"         $J "await rename(tmp, file);" ""
run_str "a state write error crashes the run"         $J "log({ event: 'state_not_saved', message: oneLine(err?.message) });" "throw err;"

# ================================================================== ci-metrics.mjs: backup, data, publishing
run_str "the oldest backup is the newest"             $J "return seconds(Math.max(...times), now);" "return seconds(Math.min(...times), now);"
run_str "the config archives count as backups"        $J "'--prefix', BACKUP_PREFIX," "'--prefix', '',"
run_str "an empty bucket is a fresh backup"           $J "log({ event: 'backup_none_found', prefix: BACKUP_PREFIX });
      return null;" "log({ event: 'backup_none_found', prefix: BACKUP_PREFIX });
      return 0;"
run_str "a failed listing is a fresh backup"          $J "log({ event: 'backup_listing_failed', message: oneLine(err?.message) });
    return null;" "log({ event: 'backup_listing_failed', message: oneLine(err?.message) });
    return 0;"
run_str "bucket name not checked"                     $J "if (!BUCKET_OK.test(bucket)) {" "if (false) {"
run_str "bucket listed in another region"             $J "'--output', 'json', '--region', region]" "'--output', 'json', '--region', 'us-east-1']"
run_str "failure metric published inverted"           $J "add(METRIC.gitlabReadFailed, gitlabFailed ? 1 : 0, 'Count');" "add(METRIC.gitlabReadFailed, gitlabFailed ? 0 : 1, 'Count');"
run_str "queue numbers published after a failure"     $J "if (!gitlabFailed && queue) {" "if (queue) {"
run_str "a negative number is published"              $J "if (!isNumber(value) || value < 0) return;" "if (!isNumber(value)) return;"
run_str "a null is published as 0"                    $J "if (!isNumber(value) || value < 0) return;" "if (value === null) value = 0; if (!isNumber(value) || value < 0) return;"
run_str "tick metric without its unit dimension"      $J "...(dimensionUnit ? { Dimensions: [{ Name: 'Unit', Value: dimensionUnit }] } : {})," ""
run_str "dimension named wrongly"                     $J "Dimensions: [{ Name: 'Unit', Value: dimensionUnit }]" "Dimensions: [{ Name: 'unit', Value: dimensionUnit }]"
run_str "an empty publish makes a call"               $J "if (data.length === 0) return;" ""
run_str "metrics published to the default namespace"  $J "'put-metric-data', '--namespace', NAMESPACE," "'put-metric-data', '--namespace', 'CWAgent',"
run_str "metrics published in the wrong region"       $J "'--namespace', NAMESPACE, '--region', region," "'--namespace', NAMESPACE, '--region', 'us-east-1',"

# ================================================================== ci-metrics.mjs: the run and the command line
run_str "a GitLab error is not caught"                $J "  } catch (err) {
    gitlabFailed = true;" "  } catch (err) {
    throw err;
    gitlabFailed = true;"
run_str "no deadline on GitLab"                       $J "queue = await withDeadline(collectQueue({ client, now: t0, log }), options.gitlabDeadlineMs);" "queue = await collectQueue({ client, now: t0, log });"
run_str "deadline never fires"                        $J "timer = setTimeout(() => reject(new ReadError(\`GitLab did not answer within \${ms} ms\`, 'deadline')), ms);" "timer = setTimeout(() => {}, ms);"
run_str "the token is not removed from logs"          $J "log.setSecret(token);" ""
run_str "a publish failure still exits 0"             $J "    log({ event: 'publish_failed', message: oneLine(err?.message) });
    return { exitCode: 1 };" "    log({ event: 'publish_failed', message: oneLine(err?.message) });
    return { exitCode: 0 };"
run_str "a dry run publishes"                         $J "  if (options.dryRun) {
    log({ event: 'dry_run', metrics: data });
    return { exitCode: 0 };
  }" ""
run_str "units are read before the uptime is known"   $J "  const stored = await loadState(options.stateDir, TICK_UNITS, log);" "  const stored = {};"
run_str "token file not trimmed"                      $J "const token = text.trim();" "const token = text;"
run_str "any token text accepted"                     $J "if (!TOKEN_OK.test(token)) throw" "if (false) throw"
run_str "token env fallback"                          $J "    text = await readFile(file, 'utf8');" "    text = process.env.GITLAB_TOKEN ?? await readFile(file, 'utf8');"
run_str "GitLab retries only once less"               $J "retries: 2, baseDelayMs: 500" "retries: 0, baseDelayMs: 500"
run_str "the command is not required"                 $J "if (command !== 'run') throw" "if (false) throw"
run_str "an unknown option is ignored"                $J "if (!key) throw new UsageError(\`unknown option" "if (!key) continue; if (false) throw new UsageError(\`unknown option"
run_str "a missing value is accepted"                 $J "if (value === undefined || value.startsWith('--')) throw" "if (value === undefined) throw"
run_str "a bad number is accepted"                    $J "if (!Number.isInteger(n) || n < 1 || n > 600_000) throw" "if (false) throw"
run_str "no region needed"                            $J "if (!REGION_OK.test(String(o.region ?? ''))) throw" "if (false) throw"
run_str "bucket name not checked at the command line" $J "if (o.bucket !== undefined && !BUCKET_OK.test(o.bucket)) throw" "if (false) throw"
run_str "ftp URL accepted"                            $J "if (url.protocol !== 'http:' && url.protocol !== 'https:') throw" "if (false) throw"
run_str "a usage error exits 1"                       $J "    deps.stderr(\`ci-metrics: \${err.message}\\n\${USAGE}\`);
    return 2;" "    deps.stderr(\`ci-metrics: \${err.message}\\n\${USAGE}\`);
    return 1;"
run_str "a usage error prints no usage"               $J "deps.stderr(\`ci-metrics: \${err.message}\\n\${USAGE}\`);" "deps.stderr(\`ci-metrics: \${err.message}\\n\`);"
run_str "--help does nothing"                         $J "    deps.stdout(USAGE);
    return 0;" "    return 0;"
run_str "the read-only module writes to GitLab"       $J "jobs = await client.paginate(\`/projects/\${id}/jobs\`, { query: { scope: JOB_SCOPES } });" "await client.post(\`/projects/\${id}/jobs/1/cancel\`); jobs = await client.paginate(\`/projects/\${id}/jobs\`, { query: { scope: JOB_SCOPES } });"
run_str "the module runs a shell"                     $J "import { execFile } from 'node:child_process';" "import { execFile, execSync } from 'node:child_process';"
run_str "the module imports a package"                $J "import { pathToFileURL } from 'node:url';" "import { pathToFileURL } from 'node:url';
import os from 'os';"

if [ -n "${COUNT_ONLY:-}" ]; then echo "count-only: $total run_str mutations checked, $bad not found exactly once"; exit "$bad"; fi
echo
echo "mutations: $total, caught: $((total - bad)), not caught: $bad"
exit "$bad"
