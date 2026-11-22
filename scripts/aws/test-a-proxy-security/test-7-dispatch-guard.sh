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

run_all_tests
