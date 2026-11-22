# Shared helpers for the offline proxy-security tests. Sourced by run.sh and by each test-*.sh file.
#
# Nothing here calls AWS, reads a secret, or connects to a host. Every external command a test can
# reach is a stub on PATH:
#   aws                                     answers read-only calls from canned data, logs
#                                           state-changing calls, and logs any secret value read
#                                           as a VIOLATION.
#   curl, wget, ssh, scp, nc, psql, docker  log a VIOLATION and exit 97.
# An aws subcommand the stub does not know is logged as UNEXPECTED and exits 98. Any VIOLATION or
# UNEXPECTED line fails the test that caused it.

TEST_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TEST_LIB_DIR/../../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml"
SETUP="$REPO_ROOT/scripts/aws/setup-postgrest-aurora-proxy-staging.sh"
STEPS_RB="$TEST_LIB_DIR/workflow_steps.rb"
TESTS_TMP="${TESTS_TMP:-$(mktemp -d "${TMPDIR:-/tmp}/proxy-security-tests.XXXXXX")}"

STAGING_ACCOUNT="472838866351"
STAGING_ROLE_ARN="arn:aws:iam::472838866351:role/vitana-gha-staging-deploy"
REHEARSAL_DB_SECRET="vitana/aurora/rehearsal/postgrest-authenticator-uri"
STAGING_DB_SECRET="vitana/aurora/staging/postgrest-authenticator-uri"
STAGING_JWT_SECRET="vitana/gateway/staging/supabase-jwt-secret"
STAGING_HOST="aurora-staging.test.invalid"
PROD_HOST="vitana-aurora-prod.test.invalid"
# State-changing calls. A match in the stub log means a change was attempted.
MUTATION_RE='^(ecr create-|logs create-|logs put-|servicediscovery create-|ecs register-|ecs create-|ecs update-)'

FAILS=0

# ---- sandbox and stubs -------------------------------------------------------------------------

write_stubs() {
  local bin="$SANDBOX/bin"
  mkdir -p "$bin"
  cat > "$bin/aws" <<'STUB'
#!/usr/bin/env bash
# Offline aws stub. It never contacts AWS.
arg_value() { # arg_value <flag> <args...>: print the value that follows <flag>
  local want="$1"; shift
  while [ $# -gt 0 ]; do
    if [ "$1" = "$want" ]; then printf '%s' "${2:-}"; return 0; fi
    shift
  done
  return 1
}
[ "${1:-}" = --region ] && shift 2
svc="${1:-}"; sub="${2:-}"
shift $(( $# < 2 ? $# : 2 ))
line="$svc $sub $*"
printf '%s\n' "$line" >> "$STUB_LOG"
case "$line" in
  *get-secret-value*) printf 'VIOLATION secret value read: %s\n' "$line" >> "$STUB_LOG"; exit 97 ;;
esac
secret_arn() { # secret_arn <name>
  printf 'arn:aws:secretsmanager:eu-central-1:%s:secret:%s-AbCdEf' \
    "${STUB_SECRET_ACCOUNT:-${STUB_ACCOUNT:-472838866351}}" "$1"
}
case "$svc $sub" in
  "sts get-caller-identity")
    [ "${STUB_STS_RC:-0}" = 0 ] || { echo "stub: STS unavailable" >&2; exit 255; }
    case "$line" in
      *"--query Account"*) echo "${STUB_ACCOUNT:-472838866351}" ;;
      *"--query Arn"*) echo "${STUB_IDENTITY_ARN:-arn:aws:sts::472838866351:assumed-role/vitana-gha-staging-deploy/GitHubActions}" ;;
      *) echo "UNEXPECTED sts query: $line" >> "$STUB_LOG"; exit 98 ;;
    esac ;;
  "secretsmanager describe-secret")
    name=$(arg_value --secret-id "$@")
    case " ${STUB_MISSING_SECRETS:-} " in *" $name "*) echo "stub: secret not found" >&2; exit 254 ;; esac
    if [ -n "${STUB_ARN_OVERRIDE_FROM:-}" ] && [ "$name" = "$STUB_ARN_OVERRIDE_FROM" ]; then
      secret_arn "$STUB_ARN_OVERRIDE_TO"
    else
      secret_arn "$name"
    fi ;;
  "ecr describe-repositories") echo "472838866351.dkr.ecr.eu-central-1.amazonaws.com/vitana/postgrest-aurora-proxy" ;;
  "ecs describe-services")
    case "$line" in
      *"services[0].status"*) echo "${STUB_ECS_STATUS:-None}" ;;
      *"services[0].taskDefinition"*) echo "${STUB_TD_ARN:-arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-postgrest-aurora-proxy:7}" ;;
      *) echo "None" ;;
    esac ;;
  "ecs describe-task-definition") cat "${STUB_TD_FILE:?stub: STUB_TD_FILE is not set}" ;;
  "ecs register-task-definition")
    payload=$(arg_value --cli-input-json "$@")
    n=$(( $(ls -1 "$STUB_PAYLOADS" | wc -l) + 1 ))
    printf '%s' "$payload" > "$STUB_PAYLOADS/register-$n.json"
    echo "arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-postgrest-aurora-staging:$n" ;;
  "ecs update-service"|"ecs create-service")
    echo "arn:aws:ecs:eu-central-1:472838866351:service/Vitana-ECS-Cluster/vitana-postgrest-aurora-proxy" ;;
  "ecs wait") ;;
  "servicediscovery list-namespaces") echo "ns-teststaging" ;;
  "servicediscovery list-services") echo "${STUB_DNS_ARN:-}" ;;
  "servicediscovery create-service") echo "arn:aws:servicediscovery:eu-central-1:472838866351:service/srv-testdns" ;;
  "logs describe-log-groups") echo "${STUB_LOG_GROUP:-}" ;;
  "ecr create-repository"|"logs create-log-group"|"logs put-retention-policy") ;;
  *) printf 'UNEXPECTED %s\n' "$line" >> "$STUB_LOG"; exit 98 ;;
esac
STUB
  chmod +x "$bin/aws"
  local tool
  for tool in curl wget ssh scp nc psql docker; do
    cat > "$bin/$tool" <<EOF
#!/usr/bin/env bash
printf 'VIOLATION $tool called: %s\n' "\$*" >> "\$STUB_LOG"
exit 97
EOF
    chmod +x "$bin/$tool"
  done
}

# new_sandbox: a fresh stub bin, call log and payload directory for one test.
new_sandbox() {
  SANDBOX="$(mktemp -d "$TESTS_TMP/case.XXXXXX")"
  STUB_BIN="$SANDBOX/bin"
  STUB_LOG="$SANDBOX/calls.log"; : > "$STUB_LOG"
  STUB_PAYLOADS="$SANDBOX/payloads"; mkdir -p "$STUB_PAYLOADS"
  write_stubs
}

# run_env [NAME=value ...] -- <command...>: run in the repo with the stub PATH and an empty environment.
# Sets RC (exit status) and OUT (combined output). A recorded VIOLATION or UNEXPECTED call fails the test.
run_env() {
  local -a vars=()
  while [ $# -gt 0 ] && [ "$1" != -- ]; do vars+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  OUT=$(cd "$REPO_ROOT" && env -i PATH="$STUB_BIN:/usr/bin:/bin" LANG=C \
        STUB_LOG="$STUB_LOG" STUB_PAYLOADS="$STUB_PAYLOADS" "${vars[@]}" "$@" 2>&1)
  RC=$?
  if grep -Eq '^(VIOLATION|UNEXPECTED)' "$STUB_LOG"; then
    fail_expect "a call that must not happen was recorded: $(grep -E '^(VIOLATION|UNEXPECTED)' "$STUB_LOG" | head -n 1)"
  fi
  return 0
}

# step_run <step name> <file>: write one step's run block (expressions replaced). Fails if the step is missing.
step_run() { ruby "$STEPS_RB" "$WORKFLOW" run "$1" "$2"; }

# step_json <step name>: one step as JSON. Fails if the step is missing.
step_json() { ruby "$STEPS_RB" "$WORKFLOW" step "$1"; }

# write_td_fixture <file> [jq filter]: the clean task definition returned by describe-task-definition,
# optionally changed by a jq filter.
write_td_fixture() {
  local filter="${2:-.}"
  cat <<'JSON' | jq "$filter" > "$1"
{
  "family": "vitana-postgrest-aurora-proxy",
  "taskRoleArn": "arn:aws:iam::472838866351:role/vitana-ecs-task-role",
  "executionRoleArn": "arn:aws:iam::472838866351:role/vitana-ecs-task-execution-role",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "taskDefinitionArn": "arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-postgrest-aurora-proxy:7",
  "revision": 7,
  "status": "ACTIVE",
  "containerDefinitions": [
    {
      "name": "proxy",
      "image": "472838866351.dkr.ecr.eu-central-1.amazonaws.com/vitana/postgrest-aurora-proxy:staging-old",
      "essential": true,
      "environment": [{"name": "SUPABASE_AUTH_HOST", "value": "inmkhvwdcuyhnxkgfvsb.supabase.co"}],
      "secrets": []
    },
    {
      "name": "postgrest",
      "image": "postgrest/postgrest:v12.2.3",
      "essential": true,
      "environment": [
        {"name": "PGRST_DB_HOST", "value": "aurora-staging.test.invalid"},
        {"name": "PGRST_DB_NAME", "value": "vitana"}
      ],
      "secrets": [
        {"name": "PGRST_DB_URI", "valueFrom": "arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/aurora/rehearsal/postgrest-authenticator-uri-AbCdEf"},
        {"name": "PGRST_JWT_SECRET", "valueFrom": "arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/staging/supabase-jwt-secret-AbCdEf"}
      ]
    }
  ]
}
JSON
}

# ---- expectations (each failed expectation adds one to FAILS) ----------------------------------

fail_expect() { FAILS=$((FAILS + 1)); printf '    - %s\n' "$*"; }
expect_ok() { [ "$RC" -eq 0 ] || fail_expect "expected exit 0, got $RC: $(tail -n 2 <<<"$OUT" | tr '\n' ' ')"; }
expect_refused() { [ "$RC" -ne 0 ] || fail_expect "expected a refusal (non-zero exit), got 0"; }
expect_out() { grep -Eq "$1" <<<"$OUT" || fail_expect "output lacks /$1/"; }
expect_calls() { # expect_calls <regex> <count>: calls in the stub log matching <regex>
  local n
  n=$(grep -Ec "$1" "$STUB_LOG" || true)
  [ "$n" -eq "$2" ] || fail_expect "calls matching /$1/: want $2, got $n"
}
expect_no_change() {
  local n
  n=$(grep -Ec "$MUTATION_RE" "$STUB_LOG" || true)
  [ "$n" -eq 0 ] || fail_expect "state-changing calls ran: $(grep -E "$MUTATION_RE" "$STUB_LOG" | tr '\n' ';')"
}
payloads_text() { cat "$STUB_PAYLOADS"/*.json 2>/dev/null; }
expect_payload_has() { payloads_text | grep -Eq "$1" || fail_expect "registered revision lacks /$1/"; }
expect_payload_lacks() { if payloads_text | grep -Eq "$1"; then fail_expect "registered revision contains /$1/"; fi; }

# ---- runner ------------------------------------------------------------------------------------

# run_all_tests: run each function named t_* in the calling file. Each test runs in a subshell, so a
# test cannot leak state into the next one. A test passes when it records no failed expectation and
# returns 0.
run_all_tests() {
  local fn name rc
  for fn in $(declare -F | awk '$3 ~ /^t_/ { print $3 }'); do
    name="${fn#t_}"
    ( FAILS=0; "$fn" || FAILS=$((FAILS + 1)); exit $(( FAILS > 100 ? 100 : FAILS )) )
    rc=$?
    if [ "$rc" -eq 0 ]; then
      printf 'PASS %s\n' "$name"
    else
      printf 'FAIL %s (%s failed expectation(s))\n' "$name" "$rc"
    fi
  done
}
