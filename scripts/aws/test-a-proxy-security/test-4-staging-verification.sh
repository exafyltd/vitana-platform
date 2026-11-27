#!/usr/bin/env bash
# Change 4: no deploy unless the staging credentials pass the checks the workflow can run. Each check
# below stops the step, and a check that cannot run also stops it.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# verify_staging [NAME=value ...]: run the real "Verify staging credentials" step.
verify_staging() {
  step_run "Verify staging credentials before any AWS change" "$SANDBOX/verify.sh" || return 1
  run_env "STAGING_ROLE_ARN=$STAGING_ROLE_ARN" "STAGING_ACCOUNT_ID=$STAGING_ACCOUNT" \
    "PGRST_DB_SECRET_ID=$STAGING_DB_SECRET" "PGRST_JWT_SECRET_ID=$STAGING_JWT_SECRET" \
    "TARGET_AWS_REGION=eu-central-1" "STAGING_WRITER_ENDPOINT=$STAGING_HOST" "$@" -- bash "$SANDBOX/verify.sh"
}

t_verify_passes_for_the_configured_staging_role() {
  new_sandbox
  verify_staging || { fail_expect "verify step is missing"; return 0; }
  expect_ok
  expect_out 'Staging credentials checked'
  expect_out 'matched the confirmed writer endpoint'
  expect_calls '^sts get-caller-identity' 2
  expect_calls '^secretsmanager describe-secret' 2
  expect_calls '^secretsmanager get-secret-value' 1
}

t_verify_stops_when_sts_cannot_run() {
  new_sandbox
  verify_staging "STUB_STS_RC=255" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'Cannot read the AWS caller identity'
  expect_calls '^secretsmanager describe-secret' 0
}

t_verify_refuses_credentials_from_another_role() {
  new_sandbox
  verify_staging "STUB_IDENTITY_ARN=arn:aws:sts::472838866351:assumed-role/some-other-role/session" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'configured staging role'
  expect_calls '^secretsmanager describe-secret' 0
}

t_verify_refuses_a_caller_in_another_account() {
  new_sandbox
  verify_staging "STUB_ACCOUNT=111111111111" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'not the staging account'
}

t_verify_refuses_when_a_secret_is_missing() {
  new_sandbox
  verify_staging "STUB_MISSING_SECRETS=$STAGING_JWT_SECRET" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'cannot be described'
}

t_verify_refuses_a_secret_outside_the_staging_account() {
  new_sandbox
  verify_staging "STUB_SECRET_ACCOUNT=111111111111" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'not in the staging account and region'
}

t_verify_stops_when_the_role_variable_is_empty() {
  new_sandbox
  step_run "Verify staging credentials before any AWS change" "$SANDBOX/verify.sh" || { fail_expect "verify step is missing"; return 0; }
  run_env "STAGING_ROLE_ARN=" "STAGING_ACCOUNT_ID=$STAGING_ACCOUNT" \
    "PGRST_DB_SECRET_ID=$FIXTURE_DB_SECRET" "PGRST_JWT_SECRET_ID=$STAGING_JWT_SECRET" \
    "TARGET_AWS_REGION=eu-central-1" -- bash "$SANDBOX/verify.sh"
  expect_refused
  expect_out 'configured staging role'
}

run_all_tests
