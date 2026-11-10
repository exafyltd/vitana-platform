#!/usr/bin/env bash
# Mutation check for scripts/eng/free-tier-guard.test.mjs (VTID-05542, lane eng-gitlab-m2/settings, part B).
# One plan value or property of the files of part B is broken at a time in a scratch copy of infra/gitlab-engineering and scripts/eng, and the
# test must go red. A mutation counts as caught only when
#   - the mutated file still parses as what it is (node --check, bash -n, a JSON parser, PyYAML, a brace check for Terraform), and
#   - the test fails on a named case (a crash before any case runs is CRASH, not a catch).
# A mutation that changes nothing (NOOP), breaks the syntax by accident (INVALID) or leaves the test green (SURVIVED) is reported as not caught:
# it proves nothing, or it shows a property the test does not pin.
#
# usage: b-mutate-settings-host.sh <worktree>
# env:   NODE (default node)   TMPDIR (scratch copies)   PYTHONPATH (needs PyYAML)   ONLY (regex on the mutation name)
#        SHARD=i/n  run the mutations whose number modulo n is i (the shards run side by side; their outputs are joined in order)
set -u
SRC="${1:?worktree}"
NODE="${NODE:-node}"
TEST=scripts/eng/free-tier-guard.test.mjs
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mutsettingshost-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
total=0; bad=0; seq=0
SHARD_I=0; SHARD_N=1
if [ -n "${SHARD:-}" ]; then SHARD_I="${SHARD%/*}"; SHARD_N="${SHARD#*/}"; fi

parses() {   # file -> exit 0 when the file still parses as its extension says
  case "$1" in
    *.mjs)  "$NODE" --check "$1" 2>/dev/null ;;
    *.json) "$NODE" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1" 2>/dev/null ;;
    *.sh)   bash -n "$1" 2>/dev/null ;;
    *.yml)  python3 -c 'import sys, yaml; yaml.safe_load(open(sys.argv[1], encoding="utf8"))' "$1" 2>/dev/null ;;
    *.tf)   python3 - "$1" <<'PY' 2>/dev/null
import sys
t = open(sys.argv[1], encoding='utf8').read()
d = 0; i = 0; n = len(t)
while i < n:
    c = t[i]
    if c == '"':
        i += 1
        while i < n and t[i] != '"':
            i += 2 if t[i] == '\\' else 1
    elif c == '#':
        while i < n and t[i] != '\n': i += 1
    elif c == '{': d += 1
    elif c == '}':
        d -= 1
        if d < 0: sys.exit(1)
    i += 1
sys.exit(0 if d == 0 else 1)
PY
    ;;
    *)      return 0 ;;
  esac
}
fresh() {
  rm -rf "$WORK/t"; mkdir -p "$WORK/t/infra" "$WORK/t/scripts"
  cp -r "$SRC/infra/gitlab-engineering" "$WORK/t/infra/"
  cp -r "$SRC/scripts/eng" "$WORK/t/scripts/"
}

# The unmutated tree must pass, or every "caught" below would be meaningless.
fresh
base="$(cd "$WORK/t" && "$NODE" --test "$TEST" 2>&1)"
if ! grep -q '^# fail 0' <<<"$base"; then echo "baseline: the test fails on the unmutated tree"; grep -E '^not ok' <<<"$base" | head; exit 2; fi
echo "baseline: $(grep -E '^# tests ' <<<"$base" | cut -c3-) and $(grep -E '^# pass ' <<<"$base" | cut -c3-) on the unmutated tree"

run_mut() {   # name, file (relative to the worktree), perl expression
  local name="$1" file="$2" expr="$3"
  seq=$((seq + 1))
  if [ $(( (seq - 1) % SHARD_N )) -ne "$SHARD_I" ]; then return; fi
  if [ -n "${ONLY:-}" ] && ! [[ "$name" =~ $ONLY ]]; then return; fi
  fresh
  local f="$WORK/t/$file" before after
  before="$(sha256sum "$f" | cut -c1-16)"
  perl -0pi -e "$expr" "$f"
  after="$(sha256sum "$f" | cut -c1-16)"
  total=$((total + 1))
  if [ "$before" = "$after" ]; then printf '%03d NOOP        %s (the mutation changed nothing: fix the mutation)\n' "$seq" "$name"; bad=$((bad + 1)); return; fi
  if ! parses "$f"; then printf '%03d INVALID     %s (the mutated file does not parse: it proves nothing)\n' "$seq" "$name"; bad=$((bad + 1)); return; fi
  local out rc ntests failed
  out="$(cd "$WORK/t" && timeout 180 "$NODE" --test "$TEST" 2>&1)"; rc=$?
  ntests="$(grep -E '^# tests ' <<<"$out" | awk '{print $3}')"
  failed="$(grep -E '^not ok' <<<"$out" | sed -E 's/^not ok [0-9]+ - //' | cut -c1-62 | head -2 | paste -sd'|' -)"
  if [ "$rc" = 124 ]; then printf '%03d HUNG        %s\n' "$seq" "$name"; bad=$((bad + 1))
  elif [ "$rc" = 0 ] && grep -q '^# fail 0' <<<"$out"; then printf '%03d SURVIVED    %s\n' "$seq" "$name"; bad=$((bad + 1))
  elif [ "${ntests:-0}" -le 1 ]; then printf '%03d CRASH       %s (the test file crashed before running a case: %s)\n' "$seq" "$name" "$failed"; bad=$((bad + 1))
  else printf '%03d caught      %s  <- %s\n' "$seq" "$name" "$failed"; fi
}
# exact-string mutation, no regex escaping: name, file, old text, new text (the first occurrence is replaced)
run_str() { OLD="$3" NEW="$4" run_mut "$1" "$2" 's/\Q$ENV{OLD}\E/$ENV{NEW}/'; }
# append a line to a file
run_add() { ADD="$3" run_mut "$1" "$2" 's/\z/$ENV{ADD}\n/'; }

G=infra/gitlab-engineering
PL=$G/ci/platform.gitlab-ci.yml; V1=$G/ci/v1.gitlab-ci.yml; RE=$G/ci/rehearsal.gitlab-ci.yml; CJ=$G/settings/gitlab-settings.json
SS=$G/host/units/vitana-settings.service; ST=$G/host/units/vitana-settings.timer; PS=$G/host/units/vitana-platform-sync.service; PT=$G/host/units/vitana-platform-sync.timer
TF=$G/terraform/settings.tf; OPS=$G/host/ops-install.sh; M2=$G/m2.sh; ENG=scripts/eng/gitlab-settings.mjs

# ---- central CI files (task S3)
run_str "platform: no merge-request pipelines"          $PL '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
' ''
run_mut "platform: merge-request rule not first"        $PL 's/(    - if: \$CI_PIPELINE_SOURCE == "merge_request_event"\n)(    - if: \$CI_COMMIT_BRANCH == "main"\n)/$2$1/'
run_str "platform: main pipelines dropped"              $PL '    - if: $CI_COMMIT_BRANCH == "main"
' ''
run_str "platform: retry twice"                         $PL 'max: 1' 'max: 2'
run_str "platform: retry on script failures too"        $PL '      - stuck_or_timeout_failure' '      - stuck_or_timeout_failure
      - script_failure'
run_str "platform: no stuck_or_timeout retry"           $PL '
      - stuck_or_timeout_failure' ''
run_str "platform: no retry at all"                     $PL '  retry:
    max: 1
    when:
      - runner_system_failure
      - stuck_or_timeout_failure
' ''
run_str "platform: legacy runner tag"                   $PL 'tags: [vitana-eng]' 'tags: [vitana-legacy]'
run_str "platform: interruptible off"                   $PL 'interruptible: true' 'interruptible: false'
run_str "platform: typecheck installs with pnpm"        $PL '    - npm ci --no-audit --no-fund' '    - pnpm install'
run_str "platform: jest install without frozen lockfile" $PL '    - pnpm install --frozen-lockfile' '    - pnpm install'
run_str "platform: two jest shards"                     $PL 'parallel: 4' 'parallel: 2'
run_str "platform: other image"                         $PL 'node:20-bookworm' 'node:18-bookworm'
run_add "platform: a deploy job"                        $PL 'deploy-prod:
  stage: check
  script:
    - echo go'
run_add "platform: a secret from a vault"               $PL 'vault-job:
  stage: check
  secrets:
    DB:
      vault: a/b/c
  script:
    - echo go'
run_str "platform: a credential variable"               $PL '  CI: "true"' '  CI: "true"
  DEPLOY_TOKEN: abc'
run_str "platform: cloud command in a job"              $PL '    - pnpm run typecheck' '    - aws s3 ls'
run_str "v1: lint fails the pipeline"                   $V1 '  allow_failure: true
' ''
run_str "v1: build command changed"                     $V1 '    - npm run build' '    - npm run build -- --mode production'
run_str "v1: unit tests dropped"                        $V1 'unit-tests:' 'unit-test:'
run_str "v1: no merge-request pipelines"                $V1 '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
' ''
run_str "rehearsal: required job renamed"               $RE '
unit:
' '
tests:
'
run_str "rehearsal: unit runs nothing"                  $RE '    - npm test' '    - "true"'
run_str "rehearsal: unit without node check"            $RE '    - node --version
' ''
run_str "rehearsal: no retry on lost machines"          $RE '      - runner_system_failure
' ''
run_str "settings file: rehearsal CI file renamed"      $CJ '"ci_file": "rehearsal.gitlab-ci.yml"' '"ci_file": "rehearsal-ci.yml"'
run_str "settings file: rehearsal requires another job" $CJ '"required_jobs": ["unit"]' '"required_jobs": ["unit", "lint"]'

# ---- units (task S4)
run_str "settings timer: every 30 minutes"              $ST 'OnUnitActiveSec=10min' 'OnUnitActiveSec=30min'
run_str "settings timer: starts the wrong service"      $ST 'Unit=vitana-settings.service' 'Unit=vitana-land.service'
run_str "settings timer: not installed on timers"       $ST 'WantedBy=timers.target' 'WantedBy=multi-user.target'
run_str "sync timer: every 5 minutes"                   $PT 'OnUnitActiveSec=1min' 'OnUnitActiveSec=5min'
run_str "sync timer: no boot start"                     $PT 'OnBootSec=1min' 'OnBootSec=30min'
run_str "settings service: flock without -n"            $SS 'flock -n -E 0' 'flock -E 0'
run_str "settings service: flock without -E 0"          $SS 'flock -n -E 0' 'flock -n'
run_str "settings service: not niced"                   $SS 'Nice=10' 'Nice=0'
run_str "settings service: no CPU quota"                $SS 'CPUQuota=50%
' ''
run_str "settings service: no memory cap"              $SS 'MemoryMax=512M
' ''
run_str "settings service: no start timeout"            $SS 'TimeoutStartSec=480' 'TimeoutStartSec=infinity'
run_str "settings service: no env file"                 $SS 'EnvironmentFile=/etc/vitana/env
' ''
run_str "settings service: /etc not writable"           $SS 'ReadWritePaths=/etc/vitana
' ''
run_str "settings service: all of /etc writable"        $SS 'ReadWritePaths=/etc/vitana' 'ReadWritePaths=/etc'
run_str "settings service: strict sandbox"              $SS 'ProtectSystem=full' 'ProtectSystem=strict'
run_str "settings service: runs as nobody"              $SS 'Type=oneshot' 'Type=oneshot
User=nobody'
run_str "settings service: runs check, not apply"       $SS 'gitlab-settings.mjs apply' 'gitlab-settings.mjs check'
run_str "settings service: dry run"                     $SS 'gitlab-settings.mjs apply' 'gitlab-settings.mjs apply --dry-run'
run_str "settings service: another script path"         $SS '/opt/vitana/platform/scripts/eng/gitlab-settings.mjs' '/opt/vitana/scripts/gitlab-settings.mjs'
run_str "settings service: node elsewhere"              $SS '/usr/bin/node /opt' '/usr/local/bin/node /opt'
run_str "settings service: no PATH for aws"             $SS 'Environment=PATH=/usr/local/bin:/usr/bin:/bin' 'Environment=PATH=/usr/bin:/bin'
run_str "sync service: rebase instead of merge"         $PS 'merge --quiet --ff-only FETCH_HEAD' 'rebase FETCH_HEAD'
run_str "sync service: merge without --ff-only"         $PS 'merge --quiet --ff-only' 'merge --quiet'
run_str "sync service: hard reset"                      $PS 'merge --quiet --ff-only FETCH_HEAD' 'reset --hard FETCH_HEAD'
run_str "sync service: forced fetch"                    $PS 'fetch --quiet origin main' 'fetch --quiet --force origin main'
run_str "sync service: flock without -n"                $PS 'flock -n -E 0' 'flock -E 0'
run_str "sync service: no helper for the token"         $PS 'Environment=GIT_ASKPASS=/opt/vitana/git-askpass.sh
' ''
run_str "sync service: git may prompt"                  $PS 'Environment=GIT_TERMINAL_PROMPT=0' 'Environment=GIT_TERMINAL_PROMPT=1'
run_str "sync service: token in the URL"                $PS 'fetch --quiet origin main' 'fetch --quiet http://oauth2:abc@127.0.0.1/vitana/vitana-platform.git main'
run_str "sync service: not niced"                       $PS 'Nice=10' 'Nice=-5'
run_str "sync service: no memory cap"                   $PS 'MemoryMax=512M
' ''

# ---- Terraform (task S4)
run_str "settings.tf: agent secrets on every secret"    $TF '"${local.settings_secret_arn_prefix}/agents/*"' '"*"'
run_str "settings.tf: all Secrets Manager actions"      $TF '["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:CreateSecret", "secretsmanager:DescribeSecret"]' '["secretsmanager:*"]'
run_str "settings.tf: tagging granted"                  $TF '"secretsmanager:CreateSecret", "secretsmanager:DescribeSecret"]' '"secretsmanager:CreateSecret", "secretsmanager:TagResource"]'
run_str "settings.tf: agent secrets cannot be created"  $TF '"secretsmanager:PutSecretValue", "secretsmanager:CreateSecret", ' '"secretsmanager:PutSecretValue", '
run_str "settings.tf: fleet token not writable"         $TF '"secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"]' '"secretsmanager:DescribeSecret"]'
run_str "settings.tf: fleet token deletable"            $TF '"secretsmanager:PutSecretValue", "secretsmanager:DescribeSecret"]' '"secretsmanager:PutSecretValue", "secretsmanager:DeleteSecret"]'
run_str "settings.tf: webhook token writable"           $TF '"secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]' '"secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"]'
run_str "settings.tf: every fleet secret"               $TF '/fleet-runner-token-??????"' '/fleet-*"'
run_str "settings.tf: fleet token without suffix"       $TF '/fleet-runner-token-??????"' '/fleet-runner-token"'
run_str "settings.tf: webhook token another name"       $TF '/webhook-signing-token-??????"' '/webhook-token-??????"'
run_str "settings.tf: all key actions"                  $TF '["kms:Decrypt", "kms:GenerateDataKey"]' '["kms:*"]'
run_str "settings.tf: key action dropped"               $TF '["kms:Decrypt", "kms:GenerateDataKey"]' '["kms:Decrypt"]'
run_str "settings.tf: any key"                          $TF 'resources = [aws_kms_key.main.arn]' 'resources = ["*"]'
run_str "settings.tf: attached to the runner role"      $TF 'role   = aws_iam_role.gitlab.id' 'role   = aws_iam_role.runner.id'
run_str "settings.tf: policy named like another"        $TF 'name   = "settings"' 'name   = "gitlab"'
run_add "settings.tf: creates the fleet secret"         $TF 'resource "aws_secretsmanager_secret" "fleet_runner_token" {
  name = "vitana/engineering/gitlab/fleet-runner-token"
}'
run_add "settings.tf: a provider block"                 $TF 'provider "aws" {
  region = "eu-central-1"
}'
run_add "settings.tf: a variable without default"       $TF 'variable "x" {
  type = string
}'
run_str "settings.tf: another account"                  $TF ':secret:vitana/engineering/gitlab"' ':secret:vitana/engineering/other"'

# ---- host/ops-install.sh (task S4)
run_str "ops-install: node version unpinned"            $OPS 'NODE_VERSION=20.20.2' 'NODE_VERSION=20'
run_str "ops-install: wrong checksum pinned"            $OPS 'NODE_SHA256=19e56f08' 'NODE_SHA256=29e56f08'
run_str "ops-install: checksum check removed"           $OPS 'if [ "$got" != "$NODE_SHA256" ]; then' 'if false; then'
run_str "ops-install: published list ignored"           $OPS 'if ! grep -q "^$NODE_SHA256  $NODE_TARBALL\$" "$tmp/SHASUMS256.txt"; then' 'if false; then'
run_str "ops-install: node over plain http"             $OPS 'NODE_URL="https://nodejs.org' 'NODE_URL="http://nodejs.org'
run_str "ops-install: no link at /usr/bin/node"         $OPS '  if [ "$(readlink "$P/usr/bin/node" 2>/dev/null)" != "$want" ]; then ln -sfn "$want" "$P/usr/bin/node" && changed; fi
' ''
run_str "ops-install: git helper readable by all"       $OPS 'chmod 0700 "$f.new"' 'chmod 0755 "$f.new"'
run_str "ops-install: helper prints another file"       $OPS 'cat /etc/vitana/mirror-token' 'cat /etc/vitana/bootstrap-pat'
run_str "ops-install: clone does not fast-forward later" $OPS 'merge --quiet --ff-only FETCH_HEAD' 'merge --quiet FETCH_HEAD'
run_str "ops-install: checkout rebased"                 $OPS 'merge --quiet --ff-only FETCH_HEAD' 'rebase FETCH_HEAD'
run_str "ops-install: token in the clone URL"           $OPS 'GIT_URL="${OPS_GIT_URL:-http://127.0.0.1/' 'GIT_URL="${OPS_GIT_URL:-http://oauth2:abc@127.0.0.1/'
run_str "ops-install: units not by glob"                $OPS '  for f in "$UNITS_SRC"/*; do' '  for f in "$UNITS_SRC"/vitana-settings.* "$UNITS_SRC"/vitana-platform-sync.*; do'
run_str "ops-install: no daemon-reload"                 $OPS 'systemctl daemon-reload >> "$LOG" 2>&1 ||' 'true ||'
run_str "ops-install: timers enabled but not started"   $OPS 'systemctl enable --now "$t"' 'systemctl enable "$t"'
run_str "ops-install: timers not by glob"               $OPS '  for f in "$UNITS_SRC"/*.timer; do' '  for f in "$UNITS_SRC"/vitana-settings.timer; do'
run_str "ops-install: changed timer not restarted"      $OPS 'systemctl restart "$t"' 'true "$t"'
run_str "ops-install: token curl argument"              $OPS "printf 'header = \"PRIVATE-TOKEN: %s\"\\n' \"\$1\" | curl -sS -m 20 -o /dev/null -w '%{http_code}' -K - " "curl -sS -m 20 -o /dev/null -w '%{http_code}' -H \"PRIVATE-TOKEN: \$1\" "
run_str "ops-install: token mode 0644"                  $OPS 'chmod 0600 "$f.new"' 'chmod 0644 "$f.new"'
run_str "ops-install: log not scrubbed"                 $OPS '2>&1 | sed "s/$tok/[redacted]/g" >> "$LOG"' '>> "$LOG" 2>&1'
run_str "ops-install: token lives a year"               $OPS '30.days.from_now' '365.days.from_now'
run_str "ops-install: token with sudo scope"            $OPS "scopes: ['api']" "scopes: ['api', 'sudo']"
run_str "ops-install: token for another user"           $OPS "find_by_username('root')" "find_by_username('vitana-mirror')"
run_str "ops-install: a valid token is replaced"        $OPS '200) say "admin token: valid, kept"; return 0 ;;' '200) note "replacing" ;;'
run_str "ops-install: outage counts as refusal"         $OPS '      *) failed token "admin token: GitLab answered' '      *) note "x" ;;
      000) failed token "admin token: GitLab answered'
run_str "ops-install: weak token accepted"              $OPS '[[ ! "$tok" =~ ^[0-9a-f]{20}$ ]]' 'false'
run_str "ops-install: ops.d stops at the first failure" $OPS "tail -n 5 \"\$LOG\" | cut -c1-200 | sed 's/^/     /'" "tail -n 5 \"\$LOG\" | cut -c1-200 | sed 's/^/     /'; return 1"
run_str "ops-install: ops.d not run"                    $OPS '  run_ops_d
' '  true
'
run_str "ops-install: ops.d run before the checkout is good" $OPS '  CHECKOUT_OK=1' '  CHECKOUT_OK=0'
run_str "ops-install: failure not in the exit code"     $OPS '  exit 1
fi
if [ "$CHANGES" = 0 ]' '  exit 0
fi
if [ "$CHANGES" = 0 ]'
run_str "ops-install: always says changed"              $OPS 'if [ "$CHANGES" = 0 ]; then say "== done: nothing changed"' 'if false; then say "== done: nothing changed"'
run_str "ops-install: other log file"                   $OPS 'LOG="$P/var/log/vitana-bootstrap.log"' 'LOG="$P/var/log/ops-install.log"'
run_str "ops-install: xtrace on"                        $OPS 'set -uo pipefail' 'set -uxo pipefail'
run_str "ops-install: checkout hard reset"              $OPS '    after="$(git -C "$CHECKOUT" rev-parse HEAD)"' '    git -C "$CHECKOUT" reset --hard FETCH_HEAD >> "$LOG" 2>&1
    after="$(git -C "$CHECKOUT" rev-parse HEAD)"'

# ---- m2.sh (task S4)
run_str "m2: status prints the fleet token"             $M2 '  v=""
  ok=0' '  echo "$v"
  v=""
  ok=0'
run_str "m2: pending mail is fine"                      $M2 'if [ "$arn" = PendingConfirmation ]; then' 'if [ "$arn" = Pending ]; then'
run_str "m2: only three timers checked"                 $M2 'vitana-land vitana-ci-metrics; do
    grep -q' 'vitana-land; do
    grep -q'
run_str "m2: rehearse exits 0 without the script"       $M2 '  exit 1
fi
set -a; . "$ENVF"; set +a
cd "$CK" && node scripts/eng/rehearse.mjs' '  exit 0
fi
set -a; . "$ENVF"; set +a
cd "$CK" && node scripts/eng/rehearse.mjs'
run_str "m2: rehearse with six agents"                  $M2 '--agents 12' '--agents 6'
run_str "m2: rehearse another project"                  $M2 '--project rehearsal' '--project vitana-platform'
run_str "m2: settings does not pull first"              $M2 'systemctl start vitana-platform-sync.service
' ''
run_str "m2: settings pulls after"                      $M2 'echo "-- checkout: pull the newest main"
systemctl start vitana-platform-sync.service
echo "checkout sync exit: $?"
echo "-- settings sync"' 'echo "-- settings sync"
systemctl start vitana-settings.service
systemctl start vitana-platform-sync.service
echo "checkout sync exit: $?"'
run_str "m2: unknown command is fine"                   $M2 '  *) usage >&2; exit 2 ;;' '  *) usage >&2; exit 0 ;;'
run_str "m2: problems do not fail the status"           $M2 '  echo "status: $PROBLEMS thing(s) need attention (marked !! above)"
  return 1' '  echo "status: $PROBLEMS thing(s) need attention (marked !! above)"
  return 0'
run_str "m2: missing alarm is not a problem"            $M2 'problem "alarm $name does not exist"' 'echo "alarm $name does not exist"'
run_str "m2: empty fleet token is fine"                 $M2 '""|None) problem "fleet runner token: the secret is empty' '""|None) echo "fleet runner token: the secret is empty'
run_str "m2: last good run counts failed runs"          $M2 "grep '\"event\":\"done\",\"exit\":0'" "grep '\"event\":\"done\"'"
run_str "m2: status applies instead of checking"        $M2 'node scripts/eng/gitlab-settings.mjs check 2>&1' 'node scripts/eng/gitlab-settings.mjs apply 2>&1'
run_str "m2: drift is fine"                             $M2 "grep -q '^settings check exit: 0 ' <<<\"\$SSM_OUT\" ||" "true ||"
run_str "m2: install sends nothing compressed"          $M2 'gzip -9 < "$HERE/host/ops-install.sh" | base64 -w0' 'base64 -w0 < "$HERE/host/ops-install.sh"'
run_str "m2: install runs with sh"                      $M2 '&& bash /opt/vitana/ops-install.sh"' '&& sh /opt/vitana/ops-install.sh"'
run_str "m2: install failure exits 0"                   $M2 'echo "install: FAILED (Systems Manager status $SSM_STATUS). Read the lines above; the log on the machine is /var/log/vitana-bootstrap.log. It is safe to run  bash m2.sh install  again." >&2
  return 1' 'echo "install: FAILED (Systems Manager status $SSM_STATUS). Read the lines above; the log on the machine is /var/log/vitana-bootstrap.log. It is safe to run  bash m2.sh install  again." >&2
  return 0'
run_str "m2: state read from the Terraform run"         $M2 'aws s3 cp "s3://vitana-engineering-tfstate-$ACCOUNT_ID/gitlab-engineering/terraform.tfstate" -' 'terraform output -json'
run_str "m2: management account check dropped"          $M2 '[ "$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" = "$MGMT" ] ||' 'true ||'
run_str "m2: xtrace on"                                 $M2 'set -uo pipefail' 'set -uxo pipefail'

# ---- the guard itself: a Premium name in a file the guard scans must turn it red
run_add "guard: push rule in the sync script"           $ENG "await send(ctx, 'POST', \`/projects/\${id}/push_rule\`, {});"
run_add "guard: approval rules in a CI file"            $RE 'approval_rules: []'
run_add "guard: vault secrets in a CI file"             $RE '  secrets:'
run_add "guard: merge trains in the installer"          $OPS 'echo merge_trains'
run_add "guard: protected environments in Terraform"    $TF 'resource "x" "protected_environments" {}'
run_str "guard: group webhooks in the settings file"    $CJ '"group": "vitana",' '"group": "vitana", "group_webhooks": [],'
run_add "guard: code owner approval in the unit"        $SS 'ExecStartPost=/bin/true code_owner_approval_required'
run_add "guard: external status checks in the metrics" scripts/eng/gitlab-api.mjs "const x = '/projects/1/external_status_checks';"

echo "mutations: $total, not caught: $bad"
