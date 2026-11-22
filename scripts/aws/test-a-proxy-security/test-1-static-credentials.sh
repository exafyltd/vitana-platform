#!/usr/bin/env bash
# Change 1: the proxy deploy has no static AWS credential fallback. Authentication is the OIDC role only.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

t_workflow_reads_no_static_aws_keys() {
  local hits
  hits=$(grep -nE 'aws-access-key-id|aws-secret-access-key|secrets\.AWS_STAGING_|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY' "$WORKFLOW" || true)
  [ -z "$hits" ] || fail_expect "static AWS key reference in the workflow: $(tr '\n' ' ' <<<"$hits")"
}

t_configure_step_takes_only_the_oidc_role() {
  local json
  json=$(step_json "Configure AWS credentials") || { fail_expect "step 'Configure AWS credentials' is missing"; return 0; }
  jq -e '.with["role-to-assume"] == "${{ vars.AWS_STAGING_ROLE_ARN }}"' <<<"$json" >/dev/null \
    || fail_expect "role-to-assume is not vars.AWS_STAGING_ROLE_ARN"
  jq -e '(.with | has("aws-access-key-id") or has("aws-secret-access-key")) | not' <<<"$json" >/dev/null \
    || fail_expect "the configure step still sets static keys"
}

# oidc_guard <role arn>: run the "Require the staging OIDC role" step with STAGING_ROLE_ARN set to <role arn>.
oidc_guard() {
  step_run "Require the staging OIDC role" "$SANDBOX/oidc-guard.sh" || return 1
  run_env "STAGING_ROLE_ARN=$1" "STAGING_ACCOUNT_ID=$STAGING_ACCOUNT" -- bash "$SANDBOX/oidc-guard.sh"
}

t_oidc_guard_refuses_unset_role() {
  new_sandbox
  oidc_guard "" || { fail_expect "step 'Require the staging OIDC role' is missing"; return 0; }
  expect_refused
  expect_out 'is not set'
  expect_calls '^sts ' 0
}

t_oidc_guard_refuses_role_outside_staging_account() {
  new_sandbox
  oidc_guard "arn:aws:iam::111111111111:role/vitana-gha-staging-deploy" || { fail_expect "step is missing"; return 0; }
  expect_refused
  expect_out 'not a role in the staging account'
}

t_oidc_guard_refuses_production_named_role() {
  new_sandbox
  oidc_guard "arn:aws:iam::472838866351:role/vitana-gha-prod-deploy" || { fail_expect "step is missing"; return 0; }
  expect_refused
  expect_out 'production-looking role'
}

t_oidc_guard_accepts_the_staging_role() {
  new_sandbox
  oidc_guard "$STAGING_ROLE_ARN" || { fail_expect "step is missing"; return 0; }
  expect_ok
}

t_guard_steps_cannot_be_skipped_or_ignored() {
  local name json
  for name in "Refuse a run that is not from main" "Require the staging OIDC role" "Configure AWS credentials" \
              "Verify staging credentials before any AWS change"; do
    json=$(step_json "$name") || { fail_expect "step '$name' is missing"; continue; }
    jq -e '(has("continue-on-error") or has("if")) | not' <<<"$json" >/dev/null \
      || fail_expect "step '$name' can be skipped or ignored (continue-on-error or if)"
  done
}

t_guard_steps_run_before_any_aws_change() {
  local names order name idx
  names=$(ruby "$STEPS_RB" "$WORKFLOW" steps) || { fail_expect "cannot read the step list"; return 0; }
  order=""
  for name in "Refuse a run that is not from main" "Require the staging OIDC role" "Configure AWS credentials" \
              "Verify staging credentials before any AWS change" "Login to Amazon ECR" \
              "Preflight" "Build and push proxy image" "Register task-definition revision"; do
    idx=$(jq -r --arg n "$name" 'to_entries | map(select(.value | startswith($n))) | .[0].key // empty' <<<"$names")
    if [ -z "$idx" ]; then fail_expect "no step starts with '$name'"; return 0; fi
    order="$order $idx"
  done
  # Each index must be strictly greater than the one before it.
  local prev=-1 i
  for i in $order; do
    [ "$i" -gt "$prev" ] || { fail_expect "step order is wrong: indexes$order"; return 0; }
    prev=$i
  done
}

run_all_tests
