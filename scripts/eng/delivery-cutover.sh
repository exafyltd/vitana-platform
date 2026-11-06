#!/bin/bash
# The cutover of delivery from GitHub to our own GitLab, for both repositories (plan agentic-delivery §8, lane cutover, VTID-05545). The owner
# runs it in AWS CloudShell, signed in to the management account 472838866351, from a clone of exafyltd/vitana-platform. It reads GitHub, AWS
# and the GitLab machine, and changes things ONLY through the calls listed in infra/gitlab-engineering/RUNBOOK-cutover.md, each shown before it
# runs. Nothing runs by itself. No secret is put in a command line, a log or a file: the GitHub token is typed hidden (or taken from GH_TOKEN)
# and lives in this process only; the GitLab and GitHub tokens of the machine are never read by this script.
#
#   bash scripts/eng/delivery-cutover.sh status                              read only: the checklist of plan §8.1, item by item, green or red
#   bash scripts/eng/delivery-cutover.sh rehearse [--merges-paused] [--abort] [--protection-only] [--dry-run] [--break-lock]
#                                                                            the rehearsal of plan §8.1 step 5 (opens it, then closes it when the evidence is there);
#                                                                            opening it first tries the restore of the GitHub protection (the round trip)
#   bash scripts/eng/delivery-cutover.sh apply [agentic-delivery] --mirror-account LOGIN [--dry-run] [--break-lock]
#                                                                            the cut, plan §8.2 steps 1 to 8. Without the plan slug it is a dry run.
#   bash scripts/eng/delivery-rollback.sh agentic-delivery ...               plan §8.4 (the other file, which sources this one)
#
# `apply` refuses unless `status` is all green AND the plan slug is given on the command line (the owner's command naming the plan: it also
# disables PR-GATE.yml, a protected gate file). Every step first looks at the world and does nothing when it is already done, so a half-finished
# apply is resumed by running it again; a step that fails undoes what it changed in that step and stops, so no step is left half-done. The first
# thing a state-changing call does is print "CHANGE: ..."; with --dry-run (the default without the slug) it prints "WOULD: ..." and changes nothing.
# A backup (the protection of main, the list of disabled workflows, the record of the cut) is read back and compared before the GitHub change it
# protects; a backup that is missing or cannot be read is never taken as "nothing to restore". apply, rehearse and the rollback hold a lock
# ($SECRET_PREFIX/lock, created only when it does not exist) while they change things, so two of them never run at once.
# Exit: 0 done / all green, 1 a refusal, a failure or a red checklist, 2 a usage mistake, 3 waiting for the owner (the kill switch, the rehearsal).
# The CUTOVER_* variables exist so that scripts/eng/delivery-cutover.test.mjs can run this file against stand-ins; the owner sets none.
set -uo pipefail
export AWS_PAGER="" AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CUTOVER_ROOT:-$(cd "$HERE/../.." && pwd)}"
MGMT=472838866351
PLAN_SLUG=agentic-delivery
GH_OWNER=exafyltd
REPOS=(vitana-platform vitana-v1)
CHECKOUT=/opt/vitana/platform
MARKER_FILE=/etc/vitana/delivery-cutover
REHEARSAL_FILE=/etc/vitana/delivery-rehearsal.json
SECRET_PREFIX=vitana/engineering/gitlab/delivery-cutover
GATEWAY_HEALTH_URL="${CUTOVER_GATEWAY_URL:-https://gateway.vitanaland.com}/api/v1/ops/runtime/autopilot/kill-switch"
WORKFLOWS_JSON="$ROOT/scripts/eng/github-workflows.json"
STATE_FILE="${CUTOVER_STATE:-}"
KILL_WAIT_SECONDS="${CUTOVER_KILL_WAIT_SECONDS:-600}"
DEPLOY_WAIT_SECONDS="${CUTOVER_DEPLOY_WAIT_SECONDS:-2700}"   # how long the wait for a staging redeploy of GitHub Actions may take
LOCK_NAME="$SECRET_PREFIX/lock"
LOCK_STALE_SECONDS=21600     # --break-lock clears only a lock older than 6 hours
RESUME_MAX_SECONDS=86400     # apply resumes a recorded cut without the checklist only within 24 hours
ROUNDTRIP_MAX_SECONDS=604800 # the round trip of the protection counts for 7 days, like the rehearsal
STAGING_CLUSTER=Vitana-ECS-Cluster
STAGING_SERVICE=vitana-gateway
DRY=0
TMP=""
ENG_AK=""; ENG_SK=""; ENG_ST=""; ENG_AT=0; ACCOUNT_ID=""; GITLAB_ID=""
SSM_STATUS=""; SSM_OUT=""; SSM_ERR=""; SSM_CID=""
SECRET_VAL=""; SM_ERR=""; PROT_JSON=""; GH_ERR=""; LOCK_HELD=0; LOCK_RC=""; BREAK_LOCK=0
CUT_PHASE=none; CUT_MIRROR=""; CUT_AT=""
STAGING_TD=""; STAGING_VARS=""
CHECK_IDS=(); CHECK_RESULTS=(); ONLY=""
ITEM_IDS="m1 m2 m2-rehearsal lanes a1 a2 a3 shadow-commits shadow-parity shadow-targets bridge-dry-run rehearsal protection-roundtrip workflows bot-config"

# ------------------------------------------------------------------ every external call goes through one of these functions (the tests put stand-ins on PATH)
x_aws() { aws "$@"; }
x_gh() { gh "$@"; }
x_git() { git "$@"; }
x_curl() { curl "$@"; }
x_node() { node "$@"; }
x_sleep() { sleep "$@"; }
aws_m() { x_aws "$@"; }   # the signed-in (management) account
aws_e() {   # the engineering account (temporary credentials of one hour; renewed after 45 minutes, so a long wait does not end in refused writes)
  if [ -n "$ENG_AK" ] && [ $(( $(date +%s) - ENG_AT )) -ge 2700 ]; then eng_assume >/dev/null 2>&1 || true; fi
  AWS_ACCESS_KEY_ID="$ENG_AK" AWS_SECRET_ACCESS_KEY="$ENG_SK" AWS_SESSION_TOKEN="$ENG_ST" x_aws "$@"
}

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
cleanup() { lock_release; [ -z "$TMP" ] || rm -rf "$TMP"; }
trap cleanup EXIT
mk_tmp() { [ -n "$TMP" ] || TMP="$(mktemp -d "${TMPDIR:-/tmp}/delivery-cutover.XXXXXX")" || die "cannot make a temporary folder"; }

# W <description> <command...>: a state-changing call. Shown first; with a dry run it is not made.
W() {
  local d="$1"; shift
  if [ "$DRY" = 1 ]; then say "WOULD: $d"; return 0; fi
  say "CHANGE: $d"
  "$@"
}

usage() {
  cat <<'USAGE'
usage: bash scripts/eng/delivery-cutover.sh <command>
  status [--item ID]                        read only: the checklist of plan section 8.1, item by item (exit 0 only when all green);
                                            --item re-checks one item after you fixed it (m1 m2 m2-rehearsal lanes a1 a2 a3 shadow-commits ...)
  rehearse [--merges-paused] [--abort] [--protection-only] [--dry-run] [--break-lock]
                                            open the rehearsal (needs --merges-paused; it first tries the restore of the GitHub
                                            protection of main, the round trip), or close it when the evidence is there;
                                            --protection-only runs only the round trip; --dry-run prints every change as WOULD and makes none
  apply [agentic-delivery] --mirror-account LOGIN [--dry-run] [--break-lock]
                                            the cut (plan 8.2 steps 1 to 8). Give the plan slug to make the changes; without it
                                            (or with --dry-run) nothing is changed and every change is printed as WOULD.
  --break-lock                              clear a lock left by a run that died, when it is older than 6 hours
rollback: bash scripts/eng/delivery-rollback.sh agentic-delivery   (plan section 8.4)
USAGE
}

# ------------------------------------------------------------------ the world: account, region, machine, GitHub
need() { local c; for c in "$@"; do command -v "$c" >/dev/null 2>&1 || { printf 'ERROR: %s is not installed here (CloudShell has aws, git, jq and node; install gh from https://cli.github.com first)\n' "$c" >&2; exit 2; }; done; }

find_state() {
  local f
  for f in "$STATE_FILE" "$HOME/vitana-eng/state.env" "$ROOT/infra/gitlab-engineering/state.env"; do
    [ -n "$f" ] && [ -f "$f" ] && { . "$f"; return 0; }
  done
  return 0
}
eng_assume() {   # temporary credentials of the engineering account; 1 when the role cannot be assumed
  local c i
  c=""
  for i in 1 2 3; do
    c="$(aws_m sts assume-role --role-arn "arn:aws:iam::$ACCOUNT_ID:role/OrganizationAccountAccessRole" --role-session-name vitana-eng-cutover --duration-seconds 3600 --query Credentials --output json 2>/dev/null)" && break
    c=""; x_sleep 5
  done
  [ -n "$c" ] || return 1
  ENG_AK="$(jq -r .AccessKeyId <<<"$c")"; ENG_SK="$(jq -r .SecretAccessKey <<<"$c")"; ENG_ST="$(jq -r .SessionToken <<<"$c")"; ENG_AT="$(date +%s)"
}
connect_aws() {
  mk_tmp
  [ "$(aws_m sts get-caller-identity --query Account --output text 2>/dev/null)" = "$MGMT" ] || die "run this in the management account $MGMT (AWS CloudShell, signed in as the owner), region eu-central-1"
  find_state
  if [ -z "${ACCOUNT_ID:-}" ]; then
    ACCOUNT_ID="$(aws_m organizations list-accounts --query "Accounts[?Name=='vitana-engineering' && Status=='ACTIVE'].Id | [0]" --output text 2>/dev/null)"
    { [ -n "$ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != None ]; } || die "the AWS account vitana-engineering was not found: run setup.sh first"
  fi
  eng_assume || die "cannot assume OrganizationAccountAccessRole in $ACCOUNT_ID; are you in the management account $MGMT?"
  GITLAB_ID="${GITLAB_ID:-$(aws_e ec2 describe-instances --region eu-central-1 --filters "Name=tag:Name,Values=vitana-eng-gitlab" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[0].InstanceId | [0]' --output text 2>/dev/null | grep -v '^None$' || true)}"
  [ -n "$GITLAB_ID" ] || die "the GitLab machine vitana-eng-gitlab was not found in account $ACCOUNT_ID, region eu-central-1"
}
connect_github() {
  local r admin
  if [ -z "${GH_TOKEN:-}" ]; then
    read -rsp "GitHub token with admin rights on $GH_OWNER/vitana-platform and $GH_OWNER/vitana-v1 (typed hidden, never written): " GH_TOKEN
    echo
  fi
  [ -n "${GH_TOKEN:-}" ] || die "no GitHub token"
  export GH_TOKEN
  x_gh api user --jq .login >/dev/null 2>&1 || die "GitHub did not accept the token"
  for r in "${REPOS[@]}"; do
    admin="$(x_gh api "repos/$GH_OWNER/$r" --jq '.permissions.admin' 2>/dev/null)"
    [ "$admin" = true ] || die "the GitHub token has no admin rights on $GH_OWNER/$r (needed for branch protection and workflows)"
  done
}

# ------------------------------------------------------------------ Systems Manager: run a shell script on the GitLab machine (as m2.sh does)
ssm_run() {   # script, polls of 5 seconds. Sets SSM_STATUS, SSM_OUT, SSM_ERR; returns 0 when the script exited 0
  local i st params waits="${2:-60}"
  SSM_STATUS=""; SSM_OUT=""; SSM_ERR=""; SSM_CID=""
  params="$(jq -nc --arg c "$1" --arg t "${SSM_EXEC_TIMEOUT:-3600}" '{commands:[$c],executionTimeout:[$t]}')"
  SSM_CID="$(aws_e ssm send-command --instance-ids "$GITLAB_ID" --document-name AWS-RunShellScript --parameters "$params" --query Command.CommandId --output text 2>/dev/null)" || SSM_CID=""
  if [ -z "$SSM_CID" ]; then SSM_STATUS=NotSent; SSM_ERR="Systems Manager did not accept the command; wait two minutes and run it again"; return 1; fi
  st=""
  for i in $(seq 1 "$waits"); do
    x_sleep 5
    st="$(aws_e ssm get-command-invocation --command-id "$SSM_CID" --instance-id "$GITLAB_ID" --query Status --output text 2>/dev/null)"
    case "$st" in InProgress|Pending|Delayed|"") ;; *) break ;; esac
  done
  SSM_STATUS="${st:-Unknown}"
  SSM_OUT="$(aws_e ssm get-command-invocation --command-id "$SSM_CID" --instance-id "$GITLAB_ID" --query StandardOutputContent --output text 2>/dev/null)"
  SSM_ERR="$(aws_e ssm get-command-invocation --command-id "$SSM_CID" --instance-id "$GITLAB_ID" --query StandardErrorContent --output text 2>/dev/null | tail -n 8)"
  [ "$SSM_STATUS" = Success ]
}
kv() { sed -n "s/^$1=//p" <<<"$SSM_OUT" | head -n 1; }   # one key=value line of a script's output
kvfrom() { sed -n "s/^$2=//p" <<<"$1" | head -n 1; }   # the same for a saved output
rhead() { printf '# vitana-cutover: %s %s\n' "$1" "$2"; }   # the first line of every script that runs on the machine: it says whether the script only reads

# The scripts that run on the GitLab machine (POSIX sh: Run Command starts plain sh). The first line says whether the script only reads.
# They never print a token: a token file is only tested (-s) or measured (stat), and the GitLab API calls take their header from stdin.
r_probe() {
  rhead read probe; printf 'CK=%q\n' "$CHECKOUT"
  cat <<'REMOTE'
echo "marker=$(test -s /etc/vitana/delivery-cutover && tr -d '\n' < /etc/vitana/delivery-cutover | head -c 300 || echo none)"
echo "mirror_timer=$(systemctl is-enabled vitana-mirror.timer 2>&1 | head -n 1)"
echo "bridge_timer=$(systemctl is-enabled vitana-github-bridge.timer 2>&1 | head -n 1)"
echo "bridge_active=$(systemctl is-active vitana-github-bridge.timer 2>&1 | head -n 1)"
echo "land_active=$(systemctl is-active vitana-land.timer 2>&1 | head -n 1)"
for f in github-push-mirror-token github-bridge-token gitlab-bridge-token; do echo "file_$f=$(stat -c '%a %s' /etc/vitana/$f 2>/dev/null || echo missing)"; done
echo "rehearsal=$(cat /etc/vitana/delivery-rehearsal.json 2>/dev/null | tr -d '\n' | head -c 800 || true)"
echo "settings_check=$(set -a; . /etc/vitana/env; set +a; cd "$CK" && node scripts/eng/gitlab-settings.mjs check >/dev/null 2>&1; echo $?)"
tags="$(printf 'header = "PRIVATE-TOKEN: %s"\n' "$(cat /etc/vitana/settings-admin-token)" | curl -sS --config - 'http://127.0.0.1/api/v4/runners/all?type=instance_type&per_page=100' 2>/dev/null | jq -r '[.[].tag_list[]?] | unique | join(",")' 2>/dev/null)"
echo "runner_tags=${tags:-unknown}"
REMOTE
}
r_parity() {   # repo: a compact summary of the parity report (the full report stays on the machine)
  rhead read parity; printf 'CK=%q\nREPO=%q\n' "$CHECKOUT" "$1"
  cat <<'REMOTE'
cd "$CK" && node scripts/eng/parity-report.mjs --repo "$REPO" --limit 30 --min-shadow 10 2>/dev/null | jq -r '"shadow=\(.summary.shadow_commits)\nunexplained=\(.summary.unexplained)\nready_targets=\(.summary.ready.targets)\nfirst_result=\(.summary.targets.first_result.typical // "none")/\(.summary.targets.first_result.slowest // "none")\nrequired_checks=\(.summary.targets.required_checks.typical // "none")/\(.summary.targets.required_checks.slowest // "none")\nfirst_difference=\([.differences[] | select(.explained == false)][0] | if . then "\(.workflow // "-"):\(.kind):\(.sha[0:9])" else "none" end)"' || echo "parity_failed=1"
REMOTE
}
r_bridge_dry_run() {
  rhead read bridge-dry-run; printf 'CK=%q\n' "$CHECKOUT"
  cat <<'REMOTE'
out="$(cd "$CK" && node scripts/eng/github-bridge.mjs run --dry-run --state-dir "$(mktemp -d)" 2>&1)"; rc=$?
echo "bridge_rc=$rc"
echo "bridge_planned=$(printf '%s\n' "$out" | grep -c '"event":"planned"')"
echo "bridge_problems=$(printf '%s\n' "$out" | grep -c -E '"level":"error"|"event":"(branch_refused|repo_skipped|branch_failed|pull_request_failed|merge_request_failed)"')"
echo "bridge_tick_done=$(printf '%s\n' "$out" | grep -c '"event":"tick_done"')"
REMOTE
}
r_gitlab_main() {   # repo: the sha of main and every branch with its head (branch=<name> <sha>) of the GitLab project (read only, bot-metrics token through stdin)
  rhead read gitlab-main; printf 'REPO=%q\n' "$1"
  cat <<'REMOTE'
api() { printf 'header = "PRIVATE-TOKEN: %s"\n' "$(cat /etc/vitana/bot-metrics-token)" | curl -sS --config - "http://127.0.0.1/api/v4/projects/vitana%2F$REPO/$1"; }
echo "main_sha=$(api 'repository/branches/main' | jq -r '.commit.id // "none"')"
page=1; names=""; truncated=0
while [ "$page" -le 30 ]; do
  chunk="$(api "repository/branches?per_page=100&page=$page" | jq -r '.[] | "\(.name) \(.commit.id)"' 2>/dev/null)"
  [ -n "$chunk" ] || break
  names="$names$chunk
"
  [ "$(printf '%s\n' "$chunk" | wc -l)" -ge 100 ] || break
  [ "$page" -lt 30 ] || truncated=1
  page=$((page + 1))
done
echo "truncated=$truncated"
printf '%s' "$names" | sed 's/^/branch=/'
REMOTE
}
r_variable() {   # repo: the project variable DELIVERY_MODE (read only; the admin token of the sync is read from its root-only file through stdin)
  rhead read variable; printf 'REPO=%q\n' "$1"
  cat <<'REMOTE'
printf 'header = "PRIVATE-TOKEN: %s"\n' "$(cat /etc/vitana/settings-admin-token)" | curl -sS --config - "http://127.0.0.1/api/v4/projects/vitana%2F$REPO/variables/DELIVERY_MODE" | jq -r '"delivery_mode=\(.value // "none")"'
REMOTE
}
r_pipelines() {   # repo, since: pipelines of main with their jobs, as the metrics reader prints them (read only)
  rhead read pipelines; printf 'CK=%q\nREPO=%q\nSINCE=%q\n' "$CHECKOUT" "$1" "$2"
  cat <<'REMOTE'
cd "$CK" && node scripts/eng/delivery-metrics.mjs pipelines --project "vitana/$REPO" --limit 20 --token-file /etc/vitana/bot-metrics-token 2>/dev/null | jq -r --arg since "$SINCE" '[.pipelines[] | select(.created_at > $since)] | "deploy=\([.[].jobs[] | select((.name | startswith("deploy-staging")) and .status == "success")] | length)\nverify=\([.[].jobs[] | select((.name | startswith("staging-verify")) and .status == "success")] | length)"' || echo "pipelines_failed=1"
REMOTE
}
r_converge() {   # mode (live|rehearsal|none): write or remove the marker, then run the checkout sync and the settings sync
  rhead write converge; printf 'MODE=%q\nCK=%q\n' "$1" "$CHECKOUT"
  cat <<'REMOTE'
M=/etc/vitana/delivery-cutover
if [ "$MODE" = none ]; then
  rm -f "$M"
else
  umask 022
  printf '{"schema":"vitana.delivery-cutover-marker/v1","mode":"%s","plan":"agentic-delivery","at":"%s"}\n' "$MODE" "$(date -u +%FT%TZ)" > "$M.new" && mv "$M.new" "$M" || { echo "marker_written=0"; exit 1; }
fi
echo "marker_written=1"
systemctl start vitana-platform-sync.service; echo "sync_exit=$?"
T="$(date -d '2 seconds ago' '+%Y-%m-%d %H:%M:%S')"
systemctl start vitana-settings.service; echo "settings_exit=$?"
journalctl -u vitana-settings.service --since "$T" -o cat --no-pager 2>/dev/null | cut -c1-300 | tail -n 40
echo "check_exit=$(set -a; . /etc/vitana/env; set +a; cd "$CK" && node scripts/eng/gitlab-settings.mjs check >/dev/null 2>&1; echo $?)"
REMOTE
}
r_unit() {   # action unit [unit...]: systemctl on named units only
  local a="$1"; shift
  rhead write unit; printf 'ACTION=%q\nUNITS=%q\n' "$a" "$*"
  cat <<'REMOTE'
rc=0
for u in $UNITS; do
  case "$u" in vitana-mirror.timer|vitana-mirror.service|vitana-github-bridge.timer|vitana-land.timer|vitana-land.service) ;; *) echo "refused unit $u"; exit 1 ;; esac
  case "$ACTION" in
    enable-now) systemctl enable --now "$u" || rc=1 ;;
    disable-now) systemctl disable --now "$u" || rc=1 ;;
    start) systemctl start "$u" || rc=1 ;;
    stop) systemctl stop "$u" || rc=1 ;;
    *) echo "refused action $ACTION"; exit 1 ;;
  esac
done
echo "unit_exit=$rc"
for u in $UNITS; do echo "state_$u=$(systemctl is-active "$u" 2>&1 | head -n 1)/$(systemctl is-enabled "$u" 2>&1 | head -n 1)"; done
exit $rc
REMOTE
}
r_tag() {   # repo sha: create (or confirm) the cutover tag on the GitLab project with the token of the merge bot (through stdin)
  rhead write tag; printf 'REPO=%q\nSHA=%q\n' "$1" "$2"
  cat <<'REMOTE'
TAG="delivery/cutover-$REPO"
api() { printf 'header = "PRIVATE-TOKEN: %s"\n' "$(cat /etc/vitana/bot-land-token)" | curl -sS --config - "$@"; }
have="$(api "http://127.0.0.1/api/v4/projects/vitana%2F$REPO/repository/tags/delivery%2Fcutover-$REPO" | jq -r '.commit.id // "none"')"
if [ "$have" = "$SHA" ]; then echo "tag_state=exists"; exit 0; fi
if [ "$have" != none ]; then echo "tag_state=other:$have"; exit 1; fi
api -X POST "http://127.0.0.1/api/v4/projects/vitana%2F$REPO/repository/tags" --data-urlencode "tag_name=$TAG" --data-urlencode "ref=$SHA" | jq -r '"tag_state=\(if .name then "created" else "failed" end)"'
REMOTE
}
r_tag_delete() {
  rhead write tag-delete; printf 'REPO=%q\n' "$1"
  cat <<'REMOTE'
printf 'header = "PRIVATE-TOKEN: %s"\n' "$(cat /etc/vitana/bot-land-token)" | curl -sS --config - -X DELETE -o /dev/null -w 'tag_delete_http=%{http_code}\n' "http://127.0.0.1/api/v4/projects/vitana%2F$REPO/repository/tags/delivery%2Fcutover-$REPO"
REMOTE
}
r_mirror_final() {   # run the GitHub-to-GitLab copy once more
  rhead write mirror-final
  cat <<'REMOTE'
systemctl start vitana-mirror.service; echo "mirror_exit=$?"
REMOTE
}

# ------------------------------------------------------------------ reading git (lane files), GitHub, Secrets Manager
git_fetch_main() { x_git -C "$ROOT" fetch --quiet origin main 2>/dev/null; }
lane_state() {   # plan lane -> state of the lane file on origin/main, or "missing"
  local s
  s="$(x_git -C "$ROOT" show "origin/main:.kiro/specs/$1/lanes/$2.md" 2>/dev/null | sed -n 's/^state: *//p' | head -n 1)"
  printf '%s' "${s:-missing}"
}
lanes_not_done() {   # plan lane... -> the lanes whose state is not done, as lane=state
  local plan="$1" l s out=""; shift
  for l in "$@"; do s="$(lane_state "$plan" "$l")"; [ "$s" = done ] || out="$out $l=$s"; done
  printf '%s' "${out# }"
}
# Secrets Manager. Only ResourceNotFoundException means "there is no such secret"; any other error (throttling, a missing permission, an
# expired session, no network) is an error and is never read as "nothing saved".
sm_err_file() { printf '%s/sm.err.%s' "${TMP:-/tmp}" "$BASHPID"; }
secret_read() {   # name -> SECRET_VAL. 0 read, 2 the secret does not exist, 1 any other error (SM_ERR says which)
  local out rc ef; ef="$(sm_err_file)"
  SECRET_VAL=""; SM_ERR=""
  out="$(aws_e secretsmanager get-secret-value --secret-id "$1" --query SecretString --output text 2>"$ef")"; rc=$?
  if [ "$rc" = 0 ]; then SECRET_VAL="$out"; return 0; fi
  if grep -q ResourceNotFoundException "$ef" 2>/dev/null; then return 2; fi
  SM_ERR="$(tr '\n' ' ' < "$ef" 2>/dev/null | cut -c1-200)"; SM_ERR="${SM_ERR:-exit $rc}"
  return 1
}
secret_exists() {   # name: 0 exists, 2 does not exist, 1 any other error
  local ef; ef="$(sm_err_file)"; SM_ERR=""
  aws_e secretsmanager describe-secret --secret-id "$1" >/dev/null 2>"$ef" && return 0
  grep -q ResourceNotFoundException "$ef" 2>/dev/null && return 2
  SM_ERR="$(tr '\n' ' ' < "$ef" 2>/dev/null | cut -c1-200)"; return 1
}
secret_put() {   # name json: the value goes through stdin, never an argument. Then it is read back: 0 only when Secrets Manager holds exactly it
  local rc
  secret_exists "$1"; rc=$?
  case "$rc" in
    0) printf '%s' "$2" | aws_e secretsmanager put-secret-value --secret-id "$1" --secret-string file:///dev/stdin >/dev/null 2>"$(sm_err_file)" ;;
    2) printf '%s' "$2" | aws_e secretsmanager create-secret --name "$1" --description "Backup for scripts/eng/delivery-cutover.sh (plan agentic-delivery section 8.4)" --secret-string file:///dev/stdin >/dev/null 2>"$(sm_err_file)" ;;
    *) say "  Secrets Manager did not answer for $1 (${SM_ERR:-no answer}): nothing was written"; return 1 ;;
  esac || { say "  Secrets Manager did not take $1 ($(tr '\n' ' ' < "$(sm_err_file)" 2>/dev/null | cut -c1-200))"; return 1; }
  secret_read "$1"
  case $? in
    0) [ "$SECRET_VAL" = "$2" ] && return 0; say "  $1 reads back different from what was written" ;;
    2) say "  $1 cannot be found right after it was written" ;;
    *) say "  $1 cannot be read back after it was written (${SM_ERR})" ;;
  esac
  return 1
}
age_seconds() { local t; t="$(date -u -d "$1" +%s 2>/dev/null)" || { echo 999999999; return; }; echo $(( $(date -u +%s) - t )); }   # ISO time -> seconds ago

# The lock: a secret that is created only when it does not exist (create-secret refuses an existing name), deleted when the run ends.
lock_create() {
  local ef; ef="$(sm_err_file)"; LOCK_RC=""
  printf '%s' "$1" | aws_e secretsmanager create-secret --name "$LOCK_NAME" --description "Lock of scripts/eng/delivery-cutover.sh: one apply, rehearse or rollback at a time" --secret-string file:///dev/stdin >/dev/null 2>"$ef" && return 0
  if grep -q ResourceExistsException "$ef" 2>/dev/null; then LOCK_RC=exists; else LOCK_RC="error: $(tr '\n' ' ' < "$ef" 2>/dev/null | cut -c1-160)"; fi
  return 1
}
lock_take() {   # who (apply | rehearse | rollback)
  local body at age who i
  body="$(jq -nc --arg w "$1" --arg t "$(date -u +%FT%TZ)" '{holder: $w, at: $t}')"
  if lock_create "$body"; then LOCK_HELD=1; return 0; fi
  if [ "$LOCK_RC" != exists ]; then say "  the lock $LOCK_NAME could not be taken ($LOCK_RC): nothing was changed"; return 1; fi
  secret_read "$LOCK_NAME"
  who="$(jq -r '.holder // "?"' <<<"${SECRET_VAL:-{\}}" 2>/dev/null)"; at="$(jq -r '.at // ""' <<<"${SECRET_VAL:-{\}}" 2>/dev/null)"; age="$(age_seconds "$at")"
  say "  another run holds the lock $LOCK_NAME: ${who:-?} since ${at:-an unknown time} (${age} s ago). Two runs at once could undo each other's work: nothing was changed."
  if [ "$BREAK_LOCK" != 1 ]; then say "  When no other apply, rehearse or rollback is running and the lock is older than 6 hours, run the same command with --break-lock."; return 1; fi
  if [ "$age" -lt "$LOCK_STALE_SECONDS" ]; then say "  --break-lock clears only a lock older than 6 hours: wait for that run to end."; return 1; fi
  say "CHANGE: delete the stale lock $LOCK_NAME (older than 6 hours, --break-lock) and take it"
  aws_e secretsmanager delete-secret --secret-id "$LOCK_NAME" --force-delete-without-recovery >/dev/null 2>&1 || { say "  the stale lock could not be deleted"; return 1; }
  for i in 1 2 3 4 5 6; do lock_create "$body" && { LOCK_HELD=1; return 0; }; x_sleep 10; done   # a deleted name is free again after a few seconds
  say "  the lock could not be taken again after the stale one was deleted ($LOCK_RC): run the command again in a minute"
  return 1
}
lock_release() {
  [ "${LOCK_HELD:-0}" = 1 ] || return 0
  LOCK_HELD=0
  say "CHANGE: release the lock $LOCK_NAME"
  aws_e secretsmanager delete-secret --secret-id "$LOCK_NAME" --force-delete-without-recovery >/dev/null 2>&1 \
    || say "  the lock could not be released: delete the secret $LOCK_NAME in the engineering account (aws secretsmanager delete-secret --secret-id $LOCK_NAME --force-delete-without-recovery), or use --break-lock after 6 hours"
}

# The record of the cut ($SECRET_PREFIX/state): phase none | started | complete | rolling-back | rolled-back | unknown (it cannot be read)
cut_state_read() {
  CUT_PHASE=none; CUT_MIRROR=""; CUT_AT=""
  secret_read "$SECRET_PREFIX/state"
  case $? in 2) return 0 ;; 1) CUT_PHASE=unknown; return 1 ;; esac
  CUT_PHASE="$(jq -r '.phase // "none"' <<<"$SECRET_VAL" 2>/dev/null)" || CUT_PHASE=""
  [ -n "$CUT_PHASE" ] || { CUT_PHASE=unknown; SM_ERR="the record does not parse"; return 1; }
  CUT_MIRROR="$(jq -r '.mirror_account // ""' <<<"$SECRET_VAL")"; CUT_AT="$(jq -r '.at // ""' <<<"$SECRET_VAL")"
  return 0
}
cut_phase() { cut_state_read; printf '%s' "$CUT_PHASE"; }

# GitHub branch protection. Only GitHub's 404 "Branch not protected" means main has none; a 5xx, a 401 or 403, a 404 for something else or no
# answer at all is an error, never "no protection" (that would save {"absent":true} and the rollback would delete a protection that existed).
gh_err_file() { printf '%s/gh.err.%s' "${TMP:-/tmp}" "$BASHPID"; }
gh_protection() {   # repo -> PROT_JSON. 0 protected, 2 not protected, 1 an error (GH_ERR says which)
  local out rc ef; ef="$(gh_err_file)"
  PROT_JSON=""; GH_ERR=""
  out="$(x_gh api "repos/$GH_OWNER/$1/branches/main/protection" 2>"$ef")"; rc=$?
  if [ "$rc" = 0 ] && jq -e 'type == "object" and has("url")' <<<"$out" >/dev/null 2>&1; then PROT_JSON="$out"; return 0; fi
  local all; all="$out $(cat "$ef" 2>/dev/null)"
  if [ "$rc" != 0 ] && [[ "$all" == *"Branch not protected"* ]] && [[ "$all" == *404* ]]; then return 2; fi
  GH_ERR="$(tr '\n' ' ' <<<"$(cat "$ef" 2>/dev/null) $out" | cut -c1-200)"; GH_ERR="${GH_ERR:-exit $rc}"
  return 1
}
is_cut_lock() {   # protection-json mirror-login: main is the cut's lock (restricted to that one account, no required checks or reviews)
  jq -e --arg u "$2" '((.restrictions.users // []) | map(.login)) == [$u] and (.required_status_checks == null) and (.required_pull_request_reviews == null)' <<<"$1" >/dev/null 2>&1
}
looks_like_a_lock() { jq -e '((.restrictions.users // []) | length) == 1 and (.required_status_checks == null) and (.required_pull_request_reviews == null)' <<<"$1" >/dev/null 2>&1; }
protection_manual() {
  say "  MANUAL (owner): in GitHub open $GH_OWNER/$1, Settings, Branches, the rule of main. Remove the restriction to the mirror account and set the"
  say "  required checks, reviews and the other settings as they were before the cut (RUNBOOK-cutover.md section 8, 'when the protection cannot be restored')."
}

# The staging gateway: the DELIVERY_HOST_* variables of the task definition its ECS service runs (read only: two describe calls)
staging_read() {
  STAGING_TD="$(aws_m ecs describe-services --region eu-central-1 --cluster "$STAGING_CLUSTER" --services "$STAGING_SERVICE" --query 'services[0].taskDefinition' --output text 2>/dev/null)" || return 1
  { [ -n "$STAGING_TD" ] && [ "$STAGING_TD" != None ]; } || return 1
  STAGING_VARS="$(aws_m ecs describe-task-definition --region eu-central-1 --task-definition "$STAGING_TD" --query "taskDefinition.containerDefinitions[0].environment[?starts_with(name, 'DELIVERY_HOST_')].[name,value]" --output text 2>/dev/null)" || return 1
}
staging_carries_cut() { awk -F'\t' '$2 == "gitlab" { f = 1 } END { exit !f }' <<<"$STAGING_VARS"; }
staging_owner_command() {
  say "  OWNER ACTION: the GitHub redeploy keeps every variable it does not name (.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml), so DELIVERY_HOST_* stays."
  say "  Register a revision of the staging gateway without them and roll the staging service to it (account $MGMT, eu-central-1, CloudShell):"
  say "    TD=\$(aws ecs describe-services --cluster $STAGING_CLUSTER --services $STAGING_SERVICE --query 'services[0].taskDefinition' --output text)"
  say "    aws ecs describe-task-definition --task-definition \"\$TD\" --query taskDefinition | jq '.containerDefinitions[0].environment |= map(select(.name | startswith(\"DELIVERY_HOST_\") | not)) | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)' > td-without-cut.json"
  say "    NEW=\$(aws ecs register-task-definition --cli-input-json file://td-without-cut.json --query taskDefinition.taskDefinitionArn --output text)"
  say "    aws ecs update-service --cluster $STAGING_CLUSTER --service $STAGING_SERVICE --task-definition \"\$NEW\""
  say "  Then run this command again: it reads the task definition again and goes on. (The lasting fix is a line in AWS-STAGE-DEPLOY-GATEWAY.yml, RUNBOOK-cutover.md section 5.)"
}
staging_gateway_check() {   # after a redeploy: 0 when no DELIVERY_HOST_* of the staging gateway is gitlab any more
  staging_read || { say "  the task definition of the staging gateway could not be read ($STAGING_CLUSTER/$STAGING_SERVICE): look at it, then run this command again"; return 1; }
  if staging_carries_cut; then
    say "  the staging gateway ($STAGING_TD) still carries the cut settings after the redeploy: $(tr '\t\n' '= ' <<<"$STAGING_VARS")"
    staging_owner_command
    return 1
  fi
  say "  the staging gateway ($STAGING_TD) carries no cut setting any more"
}
dispatch_and_wait() {   # repo workflow-file: dispatch it on main, wait for the run that started after the dispatch, and require it to succeed
  local since waited=0 line id st concl url
  since="$(date -u -d '-60 seconds' +%FT%TZ)"
  x_gh workflow run "$2" -R "$GH_OWNER/$1" --ref main >/dev/null || { say "  GitHub did not accept the dispatch of $2 in $GH_OWNER/$1"; return 1; }
  while :; do
    line="$(x_gh api "repos/$GH_OWNER/$1/actions/workflows/$2/runs?event=workflow_dispatch&branch=main&per_page=10" 2>/dev/null | jq -r --arg s "$since" '[.workflow_runs[]? | select(.created_at >= $s)] | sort_by(.created_at) | .[0] // empty | "\(.id) \(.status) \(.conclusion // "none") \(.html_url // "-")"' 2>/dev/null)"
    read -r id st concl url <<<"$line"
    if [ "${st:-}" = completed ]; then
      [ "$concl" = success ] && { say "  $2 ran on main and succeeded ($url)"; return 0; }
      say "  $2 ended $concl ($url): staging did not return to the GitHub path; look at the run, then run this command again"; return 1
    fi
    if [ "$waited" -ge "$DEPLOY_WAIT_SECONDS" ]; then say "  $2 has not finished after $waited s (${url:-no run found yet}): look at it, then run this command again"; return 1; fi
    x_sleep 30; waited=$((waited + 30))
  done
}

wf_names() { jq -r --arg r "$1" --arg a "$2" '.repositories[$r].workflows | to_entries[] | select(.value.action == $a) | .key' "$WORKFLOWS_JSON"; }
wf_state() { awk -F'\t' -v f="$2" '{ n = split($1, a, "/"); if (a[n] == f) { print $2; exit } }' <<<"$1"; }   # listing, file -> active | disabled_manually | ...
gh_workflows() { x_gh api "repos/$GH_OWNER/$1/actions/workflows" --paginate --jq '.workflows[] | [.path, .state] | @tsv' 2>/dev/null; }   # path<TAB>state
main_sha() { x_gh api "repos/$GH_OWNER/$1/branches/main" --jq .commit.sha 2>/dev/null; }

# ------------------------------------------------------------------ the checklist of plan §8.1
item() {   # id ok|fail title detail
  CHECK_IDS+=("$1"); CHECK_RESULTS+=("$2")
  [ -z "$ONLY" ] || [ "$ONLY" = "$1" ] || return 0
  if [ "$2" = ok ]; then printf '[ OK ] %-15s %s -- %s\n' "$1" "$3" "$4"; else printf '[FAIL] %-15s %s -- %s\n' "$1" "$3" "$4"; fi
}
chk_lanes() {
  local bad
  if ! git_fetch_main; then item m1 fail "M1 done" "git fetch of origin/main failed in $ROOT"; item m2 fail "M2 lanes done" "git fetch failed"; item m2-rehearsal fail "M2 rehearsal A1 to A9 passed" "git fetch failed"; item lanes fail "every lane of plan section 9 done" "git fetch failed"; return; fi
  bad="$(lanes_not_done eng-gitlab-m1 gitlab-infra gitlab-verify)"
  if [ -z "$bad" ]; then item m1 ok "M1 done" "lanes gitlab-infra and gitlab-verify are done on origin/main"; else item m1 fail "M1 done" "not done: $bad"; fi
  bad="$(lanes_not_done eng-gitlab-m2 fleet settings merge-bot scm-webhook monitoring)"
  if [ -z "$bad" ]; then item m2 ok "the M2 lanes done" "fleet, settings, merge-bot, scm-webhook, monitoring"; else item m2 fail "the M2 lanes done" "not done: $bad"; fi
  bad="$(lanes_not_done eng-gitlab-m2 rehearsal)"
  if [ -z "$bad" ]; then item m2-rehearsal ok "M2 rehearsal A1 to A9 passed" "lane rehearsal is done"; else item m2-rehearsal fail "M2 rehearsal A1 to A9 passed" "not done: $bad"; fi
  bad="$(lanes_not_done agentic-delivery prerequisites pipelines deploy-path verify-on-gitlab merge-queue github-bridge gateway-delivery cutover)"
  if [ -z "$bad" ]; then item lanes ok "every lane of plan section 9 done" "all 8 lanes are done"; else item lanes fail "every lane of plan section 9 done" "not done: $bad"; fi
}
chk_owner_steps() {
  local missing="" r p
  p="$(aws_m iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[].Arn' --output text 2>/dev/null)"
  case "$p" in *gitlab.vitanaland.com*) ;; *) missing="$missing oidc-provider" ;; esac
  for r in gl-v1-staging gl-platform-staging gl-v1-preview gl-verify gl-record gl-assist; do aws_m iam get-role --role-name "$r" >/dev/null 2>&1 || missing="$missing $r"; done
  if [ -z "$missing" ]; then item a1 ok "owner step A1 (GitLab sign-in to AWS)" "the OIDC provider and the six gl-* roles exist"; else item a1 fail "owner step A1 (GitLab sign-in to AWS)" "missing:$missing (run scripts/aws/setup-gitlab-oidc.sh --apply)"; fi
  local type tags
  type="$(aws_e ec2 describe-instances --region eu-central-1 --instance-ids "$GITLAB_ID" --query 'Reservations[0].Instances[0].InstanceType' --output text 2>/dev/null)"
  tags="$(kv runner_tags)"
  missing=""
  [ "$type" = m6i.2xlarge ] || missing="$missing host-is-${type:-unknown}-not-m6i.2xlarge"
  for r in vitana-eng vitana-eng-main vitana-eng-deploy; do case ",$tags," in *",$r,"*) ;; *) missing="$missing no-runner-tagged-$r" ;; esac; done
  if [ -z "$missing" ]; then item a2 ok "owner step A2 (runner classes, bigger host)" "m6i.2xlarge and runners tagged vitana-eng, vitana-eng-main, vitana-eng-deploy"; else item a2 fail "owner step A2 (runner classes, bigger host)" "$missing"; fi
  missing=""
  for r in github-push-mirror-token github-bridge-token; do
    case "$(kv "file_$r")" in "600 "[1-9]*) ;; missing|"") missing="$missing /etc/vitana/$r:missing" ;; *) missing="$missing /etc/vitana/$r:not-mode-600-or-empty" ;; esac
  done
  if [ -z "$missing" ]; then item a3 ok "owner step A3 (the two GitHub tokens)" "both token files exist on the GitLab machine, mode 600"; else item a3 fail "owner step A3 (the two GitHub tokens)" "$missing (RUNBOOK-cutover.md step A3)"; fi
}
chk_shadow() {
  local r bad_c="" bad_p="" bad_t="" detail=""
  for r in "${REPOS[@]}"; do
    ssm_run "$(r_parity "$r")" 60
    if [ "$SSM_STATUS" != Success ] || [ -n "$(kv parity_failed)" ] || [ -z "$(kv shadow)" ]; then bad_c="$bad_c $r:no-report"; bad_p="$bad_p $r:no-report"; bad_t="$bad_t $r:no-report"; continue; fi
    [ "$(kv shadow)" -ge 10 ] 2>/dev/null || bad_c="$bad_c $r:$(kv shadow)-shadow-commits"
    [ "$(kv unexplained)" = 0 ] || bad_p="$bad_p $r:$(kv unexplained)-unexplained(first:$(kv first_difference))"
    [ "$(kv ready_targets)" = true ] || bad_t="$bad_t $r:first-result=$(kv first_result),required-checks=$(kv required_checks)"
    detail="$detail $r:shadow=$(kv shadow)"
  done
  if [ -z "$bad_c" ]; then item shadow-commits ok "at least 10 shadow commits per repository" "${detail# }"; else item shadow-commits fail "at least 10 shadow commits per repository" "$bad_c"; fi
  if [ -z "$bad_p" ]; then item shadow-parity ok "no unexplained difference to GitHub's results" "parity-report.mjs lists none"; else item shadow-parity fail "no unexplained difference to GitHub's results" "$bad_p"; fi
  if [ -z "$bad_t" ]; then item shadow-targets ok "within the section 5 targets (first result 1/3 min, required checks 5/10 min)" "measured on the shadow pipelines"; else item shadow-targets fail "within the section 5 targets (first result 1/3 min, required checks 5/10 min)" "$bad_t"; fi
}
chk_bridge() {   # $1: the output of the probe (the timers), the dry run is run here
  local t; t="$(kvfrom "$1" bridge_timer)"
  ssm_run "$(r_bridge_dry_run)" 60
  if [ "$SSM_STATUS" != Success ]; then item bridge-dry-run fail "bridge dry run complete" "the dry run did not run (Systems Manager status $SSM_STATUS)"; return; fi
  case "$t" in
    disabled) ;;
    enabled|enabled-runtime) item bridge-dry-run fail "bridge dry run complete" "vitana-github-bridge.timer is enabled before the cut: disable it (a second writer of the branches)"; return ;;
    *) item bridge-dry-run fail "bridge dry run complete" "vitana-github-bridge.timer is not installed (${t:-unknown}): run bash m2.sh install"; return ;;
  esac
  if [ "$(kv bridge_rc)" != 0 ] || ! [ "$(kv bridge_tick_done)" -ge 1 ] 2>/dev/null || [ "$(kv bridge_problems)" != 0 ]; then item bridge-dry-run fail "bridge dry run complete" "exit $(kv bridge_rc), $(kv bridge_problems) problem line(s), $(kv bridge_tick_done) tick_done"
  else item bridge-dry-run ok "bridge dry run complete" "$(kv bridge_planned) planned action(s), no refused branch, no error"; fi
}
chk_rehearsal() {   # $1: the output of the probe
  local rec state at none='{}'
  rec="$(kvfrom "$1" rehearsal)"; rec="${rec:-$none}"
  state="$(jq -r '.state // "none"' <<<"$rec" 2>/dev/null)"; at="$(jq -r '.finished_at // ""' <<<"$rec" 2>/dev/null)"
  if [ "$state" != passed ]; then item rehearsal fail "the rehearsal passed" "its state is ${state:-none} (bash scripts/eng/delivery-cutover.sh rehearse --merges-paused)"; return; fi
  if [ -z "$at" ] || [ "$(date -u -d "$at" +%s 2>/dev/null || echo 0)" -lt "$(( $(date -u +%s) - 7 * 86400 ))" ]; then item rehearsal fail "the rehearsal passed" "it passed on ${at:-an unknown day}: older than 7 days, run it again"; return; fi
  item rehearsal ok "the rehearsal passed" "passed $at"
}
restore_body_of() {   # a GET answer or {"absent":true} -> the normalised restore body (or {"absent":true}), to compare two protections
  if jq -e '.absent == true' <<<"$1" >/dev/null 2>&1; then echo '{"absent":true}'; else protection_restore_body <<<"$1" | jq -S -c .; fi
}
chk_roundtrip() {   # the round trip of rehearse passed within 7 days, on the protection GitHub main has today
  local r rc bad="" cur rec_p res at
  for r in "${REPOS[@]}"; do
    secret_read "$SECRET_PREFIX/roundtrip-$r"; rc=$?
    case "$rc" in 2) bad="$bad $r:never-run"; continue ;; 1) bad="$bad $r:record-unreadable"; continue ;; esac
    res="$(jq -r '.result // "none"' <<<"$SECRET_VAL" 2>/dev/null)"; at="$(jq -r '.at // ""' <<<"$SECRET_VAL" 2>/dev/null)"; rec_p="$(jq -c '.protection // {}' <<<"$SECRET_VAL" 2>/dev/null)"
    [ "$res" = passed ] || { bad="$bad $r:${res:-none}"; continue; }
    [ "$(age_seconds "$at")" -lt "$ROUNDTRIP_MAX_SECONDS" ] || { bad="$bad $r:older-than-7-days"; continue; }
    gh_protection "$r"; rc=$?
    case "$rc" in 0) cur="$(restore_body_of "$PROT_JSON")" ;; 2) cur='{"absent":true}' ;; *) bad="$bad $r:github-did-not-answer"; continue ;; esac
    [ "$cur" = "$(restore_body_of "$rec_p")" ] || bad="$bad $r:protection-changed-since"
  done
  if [ -z "$bad" ]; then item protection-roundtrip ok "the restore of the GitHub protection was tried on GitHub" "the round trip passed for both repositories within 7 days, on the protection main has today"
  else item protection-roundtrip fail "the restore of the GitHub protection was tried on GitHub" "${bad# } (bash scripts/eng/delivery-cutover.sh rehearse --protection-only)"; fi
}
chk_workflows() {
  local r f unknown="" gone="" miss="" out v1dir
  mk_tmp
  for r in "${REPOS[@]}"; do
    out="$(gh_workflows "$r")"
    [ -n "$out" ] || { item workflows fail "github-workflows.json is complete and its test is green" "GitHub listed no workflow of $r"; return; }
    while IFS=$'\t' read -r path state; do
      f="${path##*/}"
      jq -e --arg r "$r" --arg f "$f" '.repositories[$r].workflows[$f]' "$WORKFLOWS_JSON" >/dev/null 2>&1 || unknown="$unknown $r/$f"
    done <<<"$out"
    for f in $(jq -r --arg r "$r" '.repositories[$r].workflows | keys[]' "$WORKFLOWS_JSON"); do [ -n "$(wf_state "$out" "$f")" ] || gone="$gone $r/$f"; done
  done
  v1dir="$TMP/v1-workflows"; mkdir -p "$v1dir"
  for f in $(jq -r '.repositories["vitana-v1"].workflows | keys[]' "$WORKFLOWS_JSON"); do
    x_gh api -H "Accept: application/vnd.github.raw" "repos/$GH_OWNER/vitana-v1/contents/.github/workflows/$f" > "$v1dir/$f" 2>/dev/null || miss="$miss $f"
  done
  if [ -n "$unknown" ]; then item workflows fail "github-workflows.json is complete and its test is green" "workflows on GitHub that the list does not classify:$unknown"; return; fi
  if [ -n "$gone" ]; then item workflows fail "github-workflows.json is complete and its test is green" "listed, but not on GitHub:$gone"; return; fi
  if [ -n "$miss" ]; then item workflows fail "github-workflows.json is complete and its test is green" "could not read from vitana-v1:$miss"; return; fi
  if VITANA_V1_WORKFLOWS_DIR="$v1dir" x_node --test "$ROOT/scripts/eng/github-workflows.test.mjs" >"$TMP/wf-test.txt" 2>&1; then item workflows ok "github-workflows.json is complete and its test is green" "160 workflows classified, the only push-to-main production deploy is DEPLOY-CLOUDFLARE-WORKERS"
  else item workflows fail "github-workflows.json is complete and its test is green" "scripts/eng/github-workflows.test.mjs failed: $(grep -m1 -E '^not ok' "$TMP/wf-test.txt" | cut -c1-120)"; fi
}
chk_bot() {
  if x_git -C "$ROOT" show origin/main:scripts/eng/gitlab-land.mjs 2>/dev/null | grep -q 'loadEffectiveProjects'; then item bot-config ok "the merge bot reads the cut configuration" "gitlab-land.mjs uses loadEffectiveProjects"
  else item bot-config fail "the merge bot reads the cut configuration" "scripts/eng/gitlab-land.mjs does not call loadEffectiveProjects (scripts/eng/gitlab-settings.mjs): the bot would not land on the two projects after the cut"; fi
}

want() { local i; [ -z "$ONLY" ] && return 0; for i in "$@"; do [ "$ONLY" = "$i" ] && return 0; done; return 1; }   # true when no --item was given, or it is one of these
run_checklist() {   # runs every check (or the group of the one item asked for); fills CHECK_IDS and CHECK_RESULTS
  CHECK_IDS=(); CHECK_RESULTS=()
  local probe=""
  want m1 m2 m2-rehearsal lanes && chk_lanes
  if want a1 a2 a3 bridge-dry-run rehearsal; then
    ssm_run "$(r_probe)" 30
    [ "$SSM_STATUS" = Success ] || say "!! the GitLab machine did not answer Systems Manager (status $SSM_STATUS): the items that read it fail"
    probe="$SSM_OUT"
  fi
  want a1 a2 a3 && chk_owner_steps
  want shadow-commits shadow-parity shadow-targets && chk_shadow
  want bridge-dry-run && chk_bridge "$probe"
  want rehearsal && chk_rehearsal "$probe"
  want protection-roundtrip && chk_roundtrip
  want workflows && chk_workflows
  want bot-config && chk_bot
}
checklist_summary() {   # prints the verdict, returns 0 when all green
  local i bad="" n=0
  for i in "${!CHECK_IDS[@]}"; do
    [ -z "$ONLY" ] || [ "$ONLY" = "${CHECK_IDS[$i]}" ] || continue
    n=$((n + 1)); [ "${CHECK_RESULTS[$i]}" = ok ] || bad="$bad ${CHECK_IDS[$i]}"
  done
  if [ -z "$bad" ]; then if [ -n "$ONLY" ]; then say "status: $ONLY is green"; else say "status: all $n items are green: the cut may start"; fi; return 0; fi
  say "status: not green:$bad -- the cut does not start (apply refuses)"
  return 1
}
cmd_status() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --item) shift; ONLY="${1:-}"; case " $ITEM_IDS " in *" $ONLY "*) ;; *) printf 'ERROR: --item is one of: %s\n' "$ITEM_IDS" >&2; exit 2 ;; esac ;;
      *) usage >&2; exit 2 ;;
    esac
    shift
  done
  say "delivery-cutover status: the checklist of plan agentic-delivery section 8.1 (read only)"
  connect_aws; connect_github
  run_checklist
  checklist_summary
}

# ------------------------------------------------------------------ the cut, plan §8.2
GH_PROTECT_BODY=""
protection_target() { jq -n --arg u "$1" '{required_status_checks: null, enforce_admins: true, required_pull_request_reviews: null, restrictions: {users: [$u], teams: [], apps: []}, allow_force_pushes: false, allow_deletions: false}'; }
# The GET answer of the protection saved before the cut -> the body of the PUT that restores it (docs.github.com, "Update branch protection").
# A check whose GET app_id is null (any source) is sent with app_id -1 ("explicitly allow any app"; null is not an integer and is refused).
# Required checks go as `checks` when GitHub lists them, else as `contexts`, never both (the API refuses both in one call). Bypass allowances and
# dismissal restrictions are carried. `rehearse` proves this body on the real API before the cut (the round trip).
protection_restore_body() {
  jq '
    def logins: [.[]? | .login]; def slugs: [.[]? | .slug];
    def en: (.enabled // false);
    {
      required_status_checks: (if .required_status_checks then ({strict: (.required_status_checks.strict // false)} + (if ((.required_status_checks.checks // []) | length) > 0 then {checks: [.required_status_checks.checks[] | {context, app_id: (.app_id // -1)}]} else {contexts: (.required_status_checks.contexts // [])} end)) else null end),
      enforce_admins: (.enforce_admins | if . then en else false end),
      required_pull_request_reviews: (if .required_pull_request_reviews then (.required_pull_request_reviews | ({dismiss_stale_reviews, require_code_owner_reviews, required_approving_review_count, require_last_push_approval} | with_entries(select(.value != null)))
        + (if .dismissal_restrictions then {dismissal_restrictions: {users: (.dismissal_restrictions.users | logins), teams: (.dismissal_restrictions.teams | slugs), apps: (.dismissal_restrictions.apps | slugs)}} else {} end)
        + (if .bypass_pull_request_allowances then {bypass_pull_request_allowances: {users: (.bypass_pull_request_allowances.users | logins), teams: (.bypass_pull_request_allowances.teams | slugs), apps: (.bypass_pull_request_allowances.apps | slugs)}} else {} end)) else null end),
      restrictions: (if .restrictions then {users: (.restrictions.users | logins), teams: (.restrictions.teams | slugs), apps: (.restrictions.apps | slugs)} else null end),
      required_linear_history: (.required_linear_history | if . then en else false end),
      allow_force_pushes: (.allow_force_pushes | if . then en else false end),
      allow_deletions: (.allow_deletions | if . then en else false end),
      block_creations: (.block_creations | if . then en else false end),
      required_conversation_resolution: (.required_conversation_resolution | if . then en else false end),
      lock_branch: (.lock_branch | if . then en else false end),
      allow_fork_syncing: (.allow_fork_syncing | if . then en else false end)
    }'
}
gh_protect_put() { local out; out="$(printf '%s' "$2" | x_gh api -X PUT "repos/$GH_OWNER/$1/branches/main/protection" -H "Accept: application/vnd.github+json" --input - 2>&1 >/dev/null)" && return 0; GH_ERR="$(tr '\n' ' ' <<<"$out" | cut -c1-200)"; return 1; }
gh_protect_delete() {   # removing the protection of a branch that has none is done already
  local out; out="$(x_gh api -X DELETE "repos/$GH_OWNER/$1/branches/main/protection" 2>&1 >/dev/null)" && return 0
  grep -q 'Branch not protected' <<<"$out" && return 0
  GH_ERR="$(tr '\n' ' ' <<<"$out" | cut -c1-200)"; return 1
}
gh_workflow() { x_gh api -X PUT "repos/$GH_OWNER/$1/actions/workflows/$2/$3" >/dev/null; }   # repo file enable|disable
gh_tag_create() { x_gh api -X POST "repos/$GH_OWNER/$1/git/refs" -f "ref=refs/tags/delivery/cutover-$1" -f "sha=$2" >/dev/null; }
gh_tag_delete() { x_gh api -X DELETE "repos/$GH_OWNER/$1/git/refs/tags/delivery/cutover-$1" >/dev/null; }

step_title() { case "$1" in
  1) echo "GitHub main accepts pushes and merges only from the mirror account" ;;
  2) echo "the GitHub-to-GitLab copy of main runs once more, then stops" ;;
  3) echo "the cutover marker is set and the settings sync turns both projects native" ;;
  4) echo "the GitHub workflows on the disable list are disabled, PR-GATE.yml included" ;;
  5) echo "the bridge starts" ;;
  6) echo "the Dev Autopilot kill switch is on (the owner sets it in the Command Hub)" ;;
  7) echo "the first GitLab main pipeline of vitana-platform deploys the gateway with the cut settings (armed)" ;;
  8) echo "the tags delivery/cutover-vitana-platform and delivery/cutover-vitana-v1" ;;
esac; }

# step 1 ------------------------------------------------------------------------------------------------------------------------
restore_protection() {   # repo: put the protection saved before the cut back (the saved answer of GET becomes the body of PUT).
  # 0 only after GitHub took the restore. A backup that does not exist, cannot be read or does not parse is exit 1 with the manual instruction.
  local name="$SECRET_PREFIX/protection-$1" body rc
  secret_read "$name"; rc=$?
  if [ "$rc" = 2 ]; then say "  no saved protection for $1 ($name does not exist): it cannot be restored by this script"; protection_manual "$1"; return 1; fi
  if [ "$rc" != 0 ]; then say "  the saved protection of $1 cannot be read ($name: $SM_ERR): nothing was restored"; protection_manual "$1"; return 1; fi
  if jq -e '.absent == true' <<<"$SECRET_VAL" >/dev/null 2>&1; then
    gh_protect_delete "$1" || { say "  GitHub did not remove the protection of main of $1 ($GH_ERR)"; protection_manual "$1"; return 1; }
    return 0
  fi
  body="$(jq -e 'select(type == "object" and has("url"))' <<<"$SECRET_VAL" 2>/dev/null | protection_restore_body 2>/dev/null)"
  [ -n "$body" ] || { say "  the saved protection of $1 ($name) does not parse: nothing was restored"; protection_manual "$1"; return 1; }
  gh_protect_put "$1" "$body" || { say "  GitHub refused the restore of the protection of main of $1 ($GH_ERR)"; protection_manual "$1"; return 1; }
}
s1_undo() {   # repos changed in this run
  local r
  for r in "$@"; do
    say "UNDO: put the saved protection of GitHub main of $r back"
    if restore_protection "$r"; then say "undone: the protection of $r is back as it was"; else say "NOT undone: GitHub main of $r is still restricted to $MIRROR (see MANUAL above)"; fi
  done
}
step1() {
  local r rc target changed=()
  for r in "${REPOS[@]}"; do
    gh_protection "$r"; rc=$?
    if [ "$rc" = 1 ]; then
      say "  GitHub did not answer for the protection of main of $r ($GH_ERR): it cannot be saved, so GitHub main of $r is not changed"
      s1_undo "${changed[@]+"${changed[@]}"}"; return 1
    fi
    if [ "$rc" = 0 ] && is_cut_lock "$PROT_JSON" "$MIRROR"; then say "  $r: already done"; continue; fi
    target="$(protection_target "$MIRROR")"
    W "save the current protection of GitHub main of $r in $SECRET_PREFIX/protection-$r (engineering account) unless this cut saved it already, and read it back" s1_backup "$r" "$rc" \
      || { say "  the protection of $r is not saved, so GitHub main of $r is not changed"; s1_undo "${changed[@]+"${changed[@]}"}"; return 1; }
    W "PUT repos/$GH_OWNER/$r/branches/main/protection: push and merge restricted to $MIRROR, required checks and reviews removed, admins included" gh_protect_put "$r" "$target" || { say "  GitHub refused the lock of $r ($GH_ERR)"; s1_undo "${changed[@]+"${changed[@]}"}"; return 1; }
    changed+=("$r")
  done
}
s1_backup() {   # repo rc-of-gh_protection (0 protected: PROT_JSON is saved, 2 not protected: {"absent":true} is saved). 0 only when the backup reads back
  local name="$SECRET_PREFIX/protection-$1" want
  if [ "${FRESH:-0}" != 1 ]; then
    secret_read "$name"
    case $? in
      0) if jq -e 'type == "object" and (has("url") or .absent == true)' <<<"$SECRET_VAL" >/dev/null 2>&1; then say "  (already saved by this cut, read back)"; return 0; fi
         say "  the saved protection $name does not parse"; return 1 ;;
      1) say "  the saved protection $name cannot be read ($SM_ERR)"; return 1 ;;
    esac
  fi
  if [ "$2" = 0 ]; then want="$PROT_JSON"; else want='{"absent":true}'; fi
  secret_put "$SECRET_PREFIX/protection-$1" "$want"
}

# step 2 ------------------------------------------------------------------------------------------------------------------------
gitlab_main_of() { ssm_run "$(r_gitlab_main "$1")" 30; kv main_sha; }
step2() {
  local r gh gl
  ssm_run "$(r_probe)" 30
  if kv marker | grep -q '"mode":"live"'; then say "  the cutover marker is set: the GitHub-to-GitLab copy must never run after the cut (it would overwrite GitLab main with GitHub's)"; return 1; fi
  W "run the GitHub-to-GitLab copy once more (systemctl start vitana-mirror.service on the GitLab machine)" ssm_w "$(r_mirror_final)" || return 1
  for r in "${REPOS[@]}"; do
    gh="$(main_sha "$r")"; gl="$(gitlab_main_of "$r")"
    if [ "$DRY" != 1 ] && { [ -z "$gh" ] || [ "$gh" != "$gl" ]; }; then say "  GitHub main of $r is ${gh:0:12}, GitLab main is ${gl:0:12}: the final copy did not bring them together; the copy keeps running"; return 1; fi
  done
  W "stop the GitHub-to-GitLab copy (systemctl disable --now vitana-mirror.timer)" ssm_w "$(r_unit disable-now vitana-mirror.timer)"
}
ssm_w() { ssm_run "$1" "${2:-60}"; local rc=$?; [ -z "$SSM_OUT" ] || printf '%s\n' "$SSM_OUT" | sed 's/^/    | /'; [ "$rc" = 0 ] || say "  Systems Manager status $SSM_STATUS ${SSM_ERR:+($SSM_ERR)}"; return $rc; }

# step 3 ------------------------------------------------------------------------------------------------------------------------
step3() {
  local ok=0
  W "write $MARKER_FILE (mode live) on the GitLab machine, fast-forward its checkout and run the settings sync (both projects turn native: landing, required jobs lane-scope, change-suite, gate, push and tag-push webhook events, push mirror of protected branches to GitHub with divergent refs kept, protected assist/*, skipped pipelines count, DELIVERY_MODE=live)" ssm_w "$(r_converge live)" 100 || ok=1
  if [ "$DRY" != 1 ] && { [ "$ok" = 1 ] || [ "$(kv settings_exit)" != 0 ] || [ "$(kv check_exit)" != 0 ]; }; then
    say "  the settings sync did not converge (sync exit $(kv settings_exit), check exit $(kv check_exit)): removing the marker again"
    say "UNDO: remove $MARKER_FILE and run the settings sync again (both projects back to shadow)"
    ssm_w "$(r_converge none)" 100 >/dev/null || true
    return 1
  fi
}

# step 4 ------------------------------------------------------------------------------------------------------------------------
step4() {
  local r f out state todo done_now=()
  for r in "${REPOS[@]}"; do
    out="$(gh_workflows "$r")"
    todo=""
    for f in $(wf_names "$r" disable); do
      state="$(wf_state "$out" "$f")"
      [ "$state" = active ] && todo="$todo $f"
    done
    if [ -z "$todo" ]; then say "  $r: already done"; continue; fi
    W "save the list of workflows of $r that are active and about to be disabled in $SECRET_PREFIX/workflows-$r, and read it back" s4_backup "$r" "$todo" \
      || { say "  the list is not saved, so no workflow of $r is disabled"; s4_undo ${done_now[@]+"${done_now[@]}"}; return 1; }
    for f in $todo; do
      W "PUT repos/$GH_OWNER/$r/actions/workflows/$f/disable" gh_workflow "$r" "$f" disable || { s4_undo ${done_now[@]+"${done_now[@]}"}; return 1; }
      done_now+=("$r/$f")
    done
  done
}
s4_undo() {   # repo/file ...: enable again what this step disabled
  local d
  for d in "$@"; do say "UNDO: PUT repos/$GH_OWNER/${d%%/*}/actions/workflows/${d#*/}/enable"; gh_workflow "${d%%/*}" "${d#*/}" enable; done
  say "undone: the workflows disabled in this step are enabled again"
}
s4_backup() {   # repo "file file ..." -> a JSON list, merged with the list this cut saved earlier (a new cut starts a new list); 0 only when it reads back
  local old="[]" new
  if [ "${FRESH:-0}" != 1 ]; then
    secret_read "$SECRET_PREFIX/workflows-$1"
    case $? in 0) old="$SECRET_VAL" ;; 2) ;; *) say "  the saved list $SECRET_PREFIX/workflows-$1 cannot be read ($SM_ERR)"; return 1 ;; esac
  fi
  jq -e 'type == "array"' <<<"$old" >/dev/null 2>&1 || { say "  the saved list $SECRET_PREFIX/workflows-$1 does not parse"; return 1; }
  new="$(printf '%s\n' $2 | jq -R . | jq -sc --argjson o "$old" '$o + . | unique')" || return 1
  secret_put "$SECRET_PREFIX/workflows-$1" "$new"
}

# step 5 ------------------------------------------------------------------------------------------------------------------------
step5() {
  ssm_run "$(r_probe)" 30
  case "$(kv file_gitlab-bridge-token)" in "600 "[1-9]*) ;; *) say "  /etc/vitana/gitlab-bridge-token is missing: the settings sync (step 3) creates it for bot-bridge"; return 1 ;; esac
  case "$(kv file_github-bridge-token)" in "600 "[1-9]*) ;; *) say "  /etc/vitana/github-bridge-token is missing (owner step A3)"; return 1 ;; esac
  W "start the bridge (systemctl enable --now vitana-github-bridge.timer on the GitLab machine)" ssm_w "$(r_unit enable-now vitana-github-bridge.timer)"
}

# step 6 ------------------------------------------------------------------------------------------------------------------------
kill_switch_on() { x_curl -fsS -m 20 "$GATEWAY_HEALTH_URL" 2>/dev/null | jq -e '.reason == "kill_switch_on"' >/dev/null 2>&1; }   # the public read-only health check of the production gateway
step6() {
  local waited=0
  if kill_switch_on; then say "  the Dev Autopilot kill switch is on"; return 0; fi
  say "  OWNER ACTION (production control, plan B1): in the Command Hub open Dev Autopilot and switch the kill switch ON."
  say "  This script only reads it (GET $GATEWAY_HEALTH_URL) and never writes to production; the switch itself is POST /api/v1/dev-autopilot/config/kill-switch {\"armed\":true} with your Command Hub login."
  [ "$DRY" = 1 ] && { say "WOULD: wait up to ${KILL_WAIT_SECONDS}s for the kill switch to read ON at $GATEWAY_HEALTH_URL"; return 0; }
  while [ "$waited" -lt "$KILL_WAIT_SECONDS" ]; do
    x_sleep 15; waited=$((waited + 15))
    kill_switch_on && { say "  the kill switch is on"; return 0; }
  done
  say "  the kill switch is still off after ${KILL_WAIT_SECONDS}s: set it, then run this command again (steps 1 to 5 are done and are skipped)"
  return 3
}

# step 7 ------------------------------------------------------------------------------------------------------------------------
step7() {
  local r
  for r in "${REPOS[@]}"; do
    ssm_run "$(r_variable "$r")" 30
    if [ "$DRY" = 1 ]; then say "WOULD: read the CI variable DELIVERY_MODE of vitana/$r (it must be live; the settings sync sets it in step 3)"; continue; fi
    [ "$(kv delivery_mode)" = live ] || { say "  DELIVERY_MODE of vitana/$r is $(kv delivery_mode), not live"; return 1; }
  done
  say "  armed: the first landing on vitana-platform main that changes the gateway deploys it to staging with PM_AGENT_ENABLED=false, DELIVERY_HOST_VITANA_PLATFORM=gitlab and DELIVERY_HOST_VITANA_V1=gitlab"
}

# step 8 ------------------------------------------------------------------------------------------------------------------------
step8() {
  local r sha gh_made=() gl_made=() d
  s8_undo() {
    for d in ${gl_made[@]+"${gl_made[@]}"}; do say "UNDO: delete the tag delivery/cutover-$d on GitLab"; ssm_w "$(r_tag_delete "$d")" 30 >/dev/null || true; done
    for d in ${gh_made[@]+"${gh_made[@]}"}; do say "UNDO: delete the tag delivery/cutover-$d on GitHub"; gh_tag_delete "$d" || true; done
    say "undone: the tags created in this step are deleted again"
  }
  for r in "${REPOS[@]}"; do
    sha="$(main_sha "$r")"
    if x_gh api "repos/$GH_OWNER/$r/git/ref/tags/delivery/cutover-$r" >/dev/null 2>&1; then say "  $r: tag exists on GitHub"
    else W "create the tag delivery/cutover-$r on GitHub at ${sha:0:12} (git/refs)" gh_tag_create "$r" "$sha" || { s8_undo; return 1; }; gh_made+=("$r"); fi
    W "create the tag delivery/cutover-$r on GitLab at ${sha:0:12} (repository/tags, token of bot-land)" ssm_w "$(r_tag "$r" "$sha")" 30 || { s8_undo; return 1; }
    gl_made+=("$r")
  done
}

step_done() {   # n -> 0 when the world already shows step n
  local r f out state
  case "$1" in
    1) for r in "${REPOS[@]}"; do gh_protection "$r" && is_cut_lock "$PROT_JSON" "$MIRROR" || return 1; done ;;
    2) ssm_run "$(r_probe)" 30; case "$(kv mirror_timer)" in disabled|masked) ;; *) return 1 ;; esac ;;
    3) ssm_run "$(r_probe)" 30; kv marker | grep -q '"mode":"live"' && [ "$(kv settings_check)" = 0 ] || return 1 ;;
    4) for r in "${REPOS[@]}"; do out="$(gh_workflows "$r")"; for f in $(wf_names "$r" disable); do [ "$(wf_state "$out" "$f")" = active ] && return 1; done; done ;;
    5) ssm_run "$(r_probe)" 30; [ "$(kv bridge_active)" = active ] || return 1 ;;
    6) kill_switch_on || return 1 ;;
    7) return 1 ;;   # a read-only check that is made every time, so that the "armed" line is always printed
    8) for r in "${REPOS[@]}"; do x_gh api "repos/$GH_OWNER/$r/git/ref/tags/delivery/cutover-$r" >/dev/null 2>&1 || return 1; done ;;
  esac
  return 0
}

cut_state_put() {   # phase [mirror account]: written and read back (secret_put); the mirror account of the cut is kept for the rollback
  secret_put "$SECRET_PREFIX/state" "$(jq -nc --arg p "$1" --arg m "${2-$MIRROR}" --arg t "$(date -u +%FT%TZ)" '{phase: $p, mirror_account: $m, at: $t}')"
}
MIRROR=""
check_mirror_account() {
  local r p
  [[ "$MIRROR" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$ ]] || die "--mirror-account must be the GitHub login of the account that owns the push-mirror token"
  for r in "${REPOS[@]}"; do
    p="$(x_gh api "repos/$GH_OWNER/$r/collaborators/$MIRROR/permission" --jq .permission 2>/dev/null)"
    case "$p" in admin|maintain|write) ;; *) die "$MIRROR has no push access to $GH_OWNER/$r (GitHub says: ${p:-no such collaborator}): the mirror could not push main there" ;; esac
  done
}

cmd_apply() {
  local slug="" n rc
  MIRROR=""; DRY=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) DRY=1; DRY_FORCED=1 ;;
      --break-lock) BREAK_LOCK=1 ;;
      --mirror-account) shift; MIRROR="${1:-}" ;;
      --mirror-account=*) MIRROR="${1#*=}" ;;
      -*) usage >&2; exit 2 ;;
      *) [ -z "$slug" ] || { usage >&2; exit 2; }; slug="$1" ;;
    esac
    shift
  done
  if [ -n "$slug" ] && [ "$slug" != "$PLAN_SLUG" ]; then printf 'ERROR: the plan slug is %s (you gave %s): nothing was done\n' "$PLAN_SLUG" "$slug" >&2; exit 2; fi
  if [ "$slug" = "$PLAN_SLUG" ] && [ "${DRY_FORCED:-0}" != 1 ]; then DRY=0; fi
  if [ "$DRY" = 1 ]; then say "apply: DRY RUN: nothing will be changed ($([ "${DRY_FORCED:-0}" = 1 ] && echo '--dry-run' || echo "no plan slug given: give $PLAN_SLUG to make the changes"))"; fi
  [ -n "$MIRROR" ] || { if [ "$DRY" = 1 ]; then MIRROR="<mirror-account>"; else printf 'ERROR: give --mirror-account LOGIN: the GitHub account that owns the push-mirror token\n' >&2; exit 2; fi; }
  connect_aws; connect_github
  [ "$MIRROR" = "<mirror-account>" ] || check_mirror_account
  FRESH=1
  local phase age resume=0
  cut_state_read || { say "apply: refused: the record $SECRET_PREFIX/state cannot be read ($SM_ERR). Nothing was changed."; exit 1; }
  phase="$CUT_PHASE"
  case "$phase" in
    rolling-back)
      say "apply: refused: a rollback started at $CUT_AT and has not finished ($SECRET_PREFIX/state is rolling-back). Finish it first:"
      say "  bash scripts/eng/delivery-rollback.sh $PLAN_SLUG     (then this command starts a new cut from the checklist). Nothing was changed."
      exit 1 ;;
    started|complete)
      FRESH=0
      if [ -n "$CUT_MIRROR" ] && [ "$MIRROR" != "<mirror-account>" ] && [ "$CUT_MIRROR" != "$MIRROR" ]; then say "apply: refused: the recorded cut uses the mirror account $CUT_MIRROR, not $MIRROR. Nothing was changed."; exit 1; fi
      age="$(age_seconds "$CUT_AT")"
      if [ "$age" -lt "$RESUME_MAX_SECONDS" ]; then
        resume=1
        say "== resuming a cut that this script started at $CUT_AT ($SECRET_PREFIX/state says $phase, less than 24 hours ago): the checklist was green then and is not asked again"
      else
        say "== the cut recorded in $SECRET_PREFIX/state ($phase) is from ${CUT_AT:-an unknown time}, older than 24 hours: it is resumed only after the checklist is green again"
        say "   (to go back instead: bash scripts/eng/delivery-rollback.sh $PLAN_SLUG). The backups of that cut are kept."
      fi ;;
    none|rolled-back) ;;
    *) say "apply: refused: $SECRET_PREFIX/state has the phase '$phase', which this script does not know. Nothing was changed."; exit 1 ;;
  esac
  if [ "$resume" = 0 ]; then
    say "== the checklist of plan section 8.1"
    run_checklist
    if ! checklist_summary; then
      if [ "$FRESH" = 0 ]; then say "apply: refused. Nothing was changed. Make the checklist green to resume the old cut, or roll it back: bash scripts/eng/delivery-rollback.sh $PLAN_SLUG"; else say "apply: refused. Nothing was changed."; fi
      exit 1
    fi
  fi
  W "take the lock $LOCK_NAME (no other apply, rehearse or rollback can run while this one does)" lock_take apply || { say "apply: refused. Nothing was changed."; exit 1; }
  if [ "$DRY" = 0 ]; then   # the record again, now under the lock: another run may have changed it while the checklist ran
    cut_state_read && [ "$CUT_PHASE" = "$phase" ] || { say "apply: refused: $SECRET_PREFIX/state changed while the checklist ran (now ${CUT_PHASE}). Nothing was changed."; exit 1; }
  fi
  if [ "$resume" = 0 ]; then
    W "record in $SECRET_PREFIX/state that a cut has started (engineering account), and read it back" cut_state_put started \
      || { say "apply: refused: the start of the cut could not be recorded, so nothing is changed on GitHub or GitLab."; exit 1; }
  fi
  for n in 1 2 3 4 5 6 7 8; do
    say "== STEP $n of 8: $(step_title "$n")"
    if [ "$DRY" = 0 ] && step_done "$n"; then say "  already done"; continue; fi
    "step$n"; rc=$?
    if [ "$rc" != 0 ]; then
      say "apply: STOPPED at step $n (exit $rc). Steps 1 to $((n - 1)) are done; step $n changed nothing that is left half-done."
      say "  Run the same command again to continue, or  bash scripts/eng/delivery-rollback.sh $PLAN_SLUG  to go back."
      exit "$rc"
    fi
  done
  if [ "$(cut_phase)" != complete ]; then
    W "record in $SECRET_PREFIX/state that the cut is complete" cut_state_put complete || { say "apply: the eight steps are done, but $SECRET_PREFIX/state could not be written: run this command again"; exit 1; }
  fi
  if [ "$DRY" = 1 ]; then say "apply: dry run finished, nothing was changed"; else say "apply: the cut is done. Follow-up: RUNBOOK-cutover.md section 'After the cut' (the first landing, the Delivery screen)."; fi
}

# ------------------------------------------------------------------ the rehearsal, plan §8.1 step 5
rehearsal_record() { ssm_run "$(r_probe)" 30; kv rehearsal; }
# The round trip (plan §8.4 restore, tried before the cut): the current protection of main is turned into the restore body, PUT back onto main,
# read again and turned into the restore body again; both must be equal. This is the call the rollback makes, on the real API, before the cut.
protection_roundtrip() {   # repo: 0 passed (recorded in $SECRET_PREFIX/roundtrip-<repo>)
  local r="$1" rc before b1 b2 name="$SECRET_PREFIX/roundtrip-$1" now
  now="$(date -u +%FT%TZ)"
  gh_protection "$r"; rc=$?
  if [ "$rc" = 1 ]; then say "  GitHub did not answer for the protection of main of $r ($GH_ERR): the round trip did not run"; return 1; fi
  if [ "$rc" = 2 ]; then
    say "  $r: main has no protection, so the way back is a DELETE, which needs no body"
    say "CHANGE: record in $name that the round trip passed (no protection)"
    secret_put "$SECRET_PREFIX/roundtrip-$r" "$(jq -nc --arg t "$now" '{result: "passed", at: $t, protection: {absent: true}}')"; return $?
  fi
  before="$PROT_JSON"
  if looks_like_a_lock "$before"; then say "  $r: main is restricted to one account with no required checks (a cut?): the round trip needs the protection of before the cut"; return 1; fi
  b1="$(restore_body_of "$before")"
  if ! gh_protect_put "$r" "$b1"; then
    say "  GitHub refused the restore body for $r ($GH_ERR): the rollback could not restore this protection. Nothing changed on GitHub; fix protection_restore_body before the cut."
    say "CHANGE: record in $name that the round trip failed"
    secret_put "$SECRET_PREFIX/roundtrip-$r" "$(jq -nc --arg t "$now" --arg e "$GH_ERR" '{result: "failed", at: $t, error: $e}')" >/dev/null; return 1
  fi
  gh_protection "$r"; rc=$?
  b2=""; [ "$rc" = 0 ] && b2="$(restore_body_of "$PROT_JSON")"
  if [ "$b1" != "$b2" ]; then
    say "  the protection of main of $r reads back different after the round trip:"
    say "    before: $b1"
    say "    after:  ${b2:-(GitHub answered $rc: ${GH_ERR:-no protection})}"
    protection_manual "$r"
    say "CHANGE: record in $name that the round trip failed"
    secret_put "$SECRET_PREFIX/roundtrip-$r" "$(jq -nc --arg t "$now" '{result: "failed", at: $t, error: "differs after the round trip"}')" >/dev/null; return 1
  fi
  say "  $r: the restore body was accepted and GitHub reads back the same protection"
  say "CHANGE: record in $name that the round trip passed"
  secret_put "$SECRET_PREFIX/roundtrip-$r" "$(jq -nc --arg t "$now" --argjson p "$before" '{result: "passed", at: $t, protection: $p}')"
}
roundtrip_all() { local r; for r in "${REPOS[@]}"; do W "round trip of the protection of GitHub main of $r: PUT the restore body made from its current protection back onto main, GET it and compare" protection_roundtrip "$r" || return 1; done; }
cmd_rehearse() {
  local paused=0 abort=0 only_protection=0 rec state started r svc since ok=1 missing=""
  while [ $# -gt 0 ]; do
    case "$1" in --merges-paused) paused=1 ;; --abort) abort=1 ;; --dry-run) DRY=1 ;; --protection-only) only_protection=1 ;; --break-lock) BREAK_LOCK=1 ;; *) usage >&2; exit 2 ;; esac
    shift
  done
  connect_aws; connect_github
  if [ "$only_protection" = 1 ]; then
    W "take the lock $LOCK_NAME" lock_take rehearse || exit 1
    roundtrip_all || { say "rehearse: the round trip of the protection FAILED: the cut does not start until it passes"; exit 1; }
    if [ "$DRY" = 1 ]; then say "rehearse: dry run finished, nothing was changed"; else say "rehearse: the round trip of the protection passed for both repositories"; fi
    return 0
  fi
  rec="$(rehearsal_record)"; state="$(jq -r '.state // "none"' <<<"${rec:-{\}}" 2>/dev/null)"
  if [ "$abort" = 1 ]; then
    [ "$state" = open ] || { say "rehearse: no rehearsal is open"; return 0; }
    W "take the lock $LOCK_NAME" lock_take rehearse || exit 1
    W "remove the marker, run the settings sync (back to shadow) and record the rehearsal as aborted" ssm_w "$(r_converge none)" 100 && W "record the rehearsal as aborted in $REHEARSAL_FILE" ssm_w "$(r_record_rehearsal aborted)" 30
    return $?
  fi
  if [ "$state" != open ]; then
    [ "$paused" = 1 ] || { say "rehearse: give --merges-paused to confirm that merges are paused except the two rehearsal landings (RUNBOOK-cutover.md, section The rehearsal)"; exit 2; }
    say "== the checklist of plan section 8.1 (the rehearsal item and the round trip of the protection are not required to be green yet)"
    run_checklist
    local i bad=""
    for i in "${!CHECK_IDS[@]}"; do [ "${CHECK_RESULTS[$i]}" = ok ] || [ "${CHECK_IDS[$i]}" = rehearsal ] || [ "${CHECK_IDS[$i]}" = protection-roundtrip ] || bad="$bad ${CHECK_IDS[$i]}"; done
    [ -z "$bad" ] || { say "rehearse: refused, not green:$bad"; exit 1; }
    W "take the lock $LOCK_NAME" lock_take rehearse || exit 1
    say "== the round trip of the GitHub protection (the restore of the rollback, tried before the cut)"
    roundtrip_all || { say "rehearse: refused: the round trip of the protection failed, so the rehearsal does not open"; exit 1; }
    W "write $MARKER_FILE with mode rehearsal and run the settings sync: both projects stay mirror projects and run the delivery pipelines with DELIVERY_MODE=live" ssm_w "$(r_converge rehearsal)" 100 || exit 1
    W "record the rehearsal as open in $REHEARSAL_FILE" ssm_w "$(r_record_rehearsal open)" 30 || exit 1
    if [ "$DRY" = 1 ]; then say "rehearse: dry run finished, nothing was changed"; return 0; fi
    say "rehearse: OPEN. Land one change that touches services/gateway in vitana-platform and one that touches the community app in vitana-v1 through the normal GitHub path; GitLab deploys them to staging."
    say "  Then run  bash scripts/eng/delivery-cutover.sh rehearse  again: it checks the evidence and closes the rehearsal."
    return 0
  fi
  started="$(jq -r '.started_at' <<<"$rec")"
  for r in "${REPOS[@]}"; do
    ssm_run "$(r_pipelines "$r" "$started")" 60
    if [ "$(kv deploy)" -ge 1 ] 2>/dev/null && [ "$(kv verify)" -ge 1 ] 2>/dev/null; then say "  $r: a live pipeline on main deployed to staging ($(kv deploy) job(s)) and STAGING-VERIFY passed ($(kv verify))"; else ok=0; missing="$missing $r"; fi
  done
  if [ "$ok" = 0 ]; then say "rehearse: not yet: no deploy-staging and staging-verify success since $started for:$missing"; return 3; fi
  W "take the lock $LOCK_NAME" lock_take rehearse || exit 1
  W "remove the marker, run the settings sync (back to shadow) and record the rehearsal as passed" ssm_w "$(r_converge none)" 100 || exit 1
  W "dispatch AWS-STAGE-DEPLOY-GATEWAY.yml and AWS-STAGE-DEPLOY-FRONTEND.yml so that staging returns to the GitHub path, wait for both runs, and read the task definition of the staging gateway again (no DELIVERY_HOST_* may be gitlab)" rehearsal_back_to_github \
    || { say "rehearse: not closed: staging is not back on the GitHub path yet. The rehearsal stays open; fix the above and run  bash scripts/eng/delivery-cutover.sh rehearse  again."; exit 1; }
  W "record the rehearsal as passed in $REHEARSAL_FILE" ssm_w "$(r_record_rehearsal passed)" 30 || exit 1
  if [ "$DRY" = 1 ]; then say "rehearse: dry run finished, nothing was changed"; return 0; fi
  say "rehearse: PASSED"
}
rehearsal_back_to_github() {
  dispatch_and_wait vitana-platform AWS-STAGE-DEPLOY-GATEWAY.yml || return 1
  say "CHANGE: dispatch AWS-STAGE-DEPLOY-FRONTEND.yml on main of $GH_OWNER/vitana-v1 and wait for the run"
  dispatch_and_wait vitana-v1 AWS-STAGE-DEPLOY-FRONTEND.yml && staging_gateway_check
}
r_record_rehearsal() {   # open|passed|aborted: the record on the machine (no secret in it)
  rhead write rehearsal-record; printf 'STATE=%q\n' "$1"
  cat <<'REMOTE'
F=/etc/vitana/delivery-rehearsal.json
now="$(date -u +%FT%TZ)"
if [ "$STATE" = open ]; then printf '{"state":"open","started_at":"%s"}\n' "$now" > "$F.new"
else started="$(jq -r '.started_at // ""' "$F" 2>/dev/null)"; printf '{"state":"%s","started_at":"%s","finished_at":"%s"}\n' "$STATE" "$started" "$now" > "$F.new"; fi
mv "$F.new" "$F" && echo "rehearsal_record=$STATE"
REMOTE
}

main() {
  need aws git jq node gh
  case "${1:-}" in
    status) shift; cmd_status "$@"; exit $? ;;
    rehearse) shift; cmd_rehearse "$@"; exit $? ;;
    apply) shift; cmd_apply "$@"; exit $? ;;
    -h|--help|help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
