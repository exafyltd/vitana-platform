#!/usr/bin/env bash
# Change 5 (F3): the deploy path runs only for refs/heads/main. A workflow_dispatch from kiro-test/* or
# from any other branch or tag stops at the first step, before checkout and before any AWS call.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# proxy_guard_run <ref>: run the proxy workflow's first step with GITHUB_REF set to <ref>.
proxy_guard_run() {
  step_run "Refuse a run that is not from main" "$SANDBOX/ref-guard.sh" || return 1
  run_env "GITHUB_REF=$1" -- bash "$SANDBOX/ref-guard.sh"
}

t_proxy_guard_refuses_kiro_test_ref() {
  new_sandbox
  proxy_guard_run refs/heads/kiro-test/proxy-security-containment \
    || { fail_expect "step 'Refuse a run that is not from main' is missing"; return 0; }
  expect_refused
  expect_out 'deploys from refs/heads/main only'
  expect_calls '^sts ' 0
}

t_proxy_guard_refuses_another_branch() {
  new_sandbox
  proxy_guard_run refs/heads/feature/any-branch || { fail_expect "step is missing"; return 0; }
  expect_refused
  expect_out 'deploys from refs/heads/main only'
  expect_calls '^sts ' 0
}

t_proxy_guard_refuses_tag_ref() {
  new_sandbox
  proxy_guard_run refs/tags/v1 || { fail_expect "step is missing"; return 0; }
  expect_refused
  expect_out 'deploys from refs/heads/main only'
  expect_calls '^sts ' 0
}

t_proxy_guard_refuses_a_run_without_a_ref() {
  new_sandbox
  step_run "Refuse a run that is not from main" "$SANDBOX/ref-guard.sh" || { fail_expect "step is missing"; return 0; }
  run_env -- bash "$SANDBOX/ref-guard.sh"
  expect_refused
  expect_out 'unset'
  expect_calls '^sts ' 0
}

t_proxy_guard_accepts_main() {
  new_sandbox
  proxy_guard_run refs/heads/main || { fail_expect "step is missing"; return 0; }
  expect_ok
}

# cutover_gate_run <ref> <action> <record run id>: the cutover workflow's gate step with these inputs.
cutover_gate_run() {
  cutover_step_run "Inputs, main, role" "$SANDBOX/cutover-gate.sh" || return 1
  run_env "REF=$1" "ACTION=$2" "RUN_ID=$3" "STAGING_ROLE_ARN=$STAGING_ROLE_ARN" -- bash "$SANDBOX/cutover-gate.sh"
}

# The cutover workflow has no ref check of its own in flip or rollback. Both jobs need the gate, and the gate refuses
# any ref other than refs/heads/main. Each refusal below is a negative test of that gate.
t_cutover_gate_refuses_kiro_test_ref() {
  new_sandbox
  cutover_gate_run refs/heads/kiro-test/proxy-security-containment rollback 123 \
    || { fail_expect "gate step 'Inputs, main, role' is missing"; return 0; }
  expect_refused
  expect_out 'run from main only'
  expect_calls '^sts ' 0
}

t_cutover_gate_refuses_tag_ref() {
  new_sandbox
  cutover_gate_run refs/tags/v1 rollback 123 || { fail_expect "gate step is missing"; return 0; }
  expect_refused
  expect_out 'run from main only'
}

t_cutover_gate_accepts_main_for_rollback() {
  new_sandbox
  cutover_gate_run refs/heads/main rollback 123 || { fail_expect "gate step is missing"; return 0; }
  expect_ok
}

t_flip_and_rollback_need_the_gate() {
  new_sandbox
  local job needs
  for job in flip rollback; do
    needs=$(ruby "$STEPS_RB" "$CUTOVER_WORKFLOW" job-needs "$job") || { fail_expect "cannot read the needs of $job"; continue; }
    jq -e 'index("gate") != null' <<<"$needs" >/dev/null || fail_expect "job $job does not need the gate: $needs"
  done
}

run_all_tests
