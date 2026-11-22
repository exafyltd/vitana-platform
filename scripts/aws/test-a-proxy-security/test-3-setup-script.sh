#!/usr/bin/env bash
# Changes 2 and 3 (provisioning script): production values are refused before any AWS change, the
# candidate revision is checked again before registration, and --apply registers nothing when the
# service already exists.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# setup_apply <db secret> <db host> [NAME=value ...]: provision --apply with the two staging inputs.
setup_apply() {
  local secret="$1" host="$2"; shift 2
  run_env "PROXY_STAGING_DB_SECRET=$secret" "PROXY_STAGING_DB_HOST=$host" "$@" -- bash "$SETUP" provision --apply
}

t_setup_refuses_when_staging_inputs_are_unset() {
  new_sandbox
  run_env -- bash "$SETUP" provision --apply
  expect_refused
  expect_out 'set PROXY_STAGING_DB_SECRET and PROXY_STAGING_DB_HOST'
  expect_no_change
}

t_setup_refuses_production_database_secret_before_any_change() {
  new_sandbox
  setup_apply "vitana/aurora/prod/postgrest-authenticator-uri" "$STAGING_HOST"
  expect_refused
  expect_out 'refusing a production'
  expect_no_change
}

t_setup_refuses_production_supabase_secret_before_any_change() {
  new_sandbox
  setup_apply "vitana/supabase/prod/jwt-secret" "$STAGING_HOST"
  expect_refused
  expect_out 'refusing a production'
  expect_no_change
}

t_setup_refuses_production_cluster_master_secret_before_any_change() {
  new_sandbox
  setup_apply "rds!cluster-4dab93b8-AbCdEf" "$STAGING_HOST"
  expect_refused
  expect_out 'refusing a production'
  expect_no_change
}

t_setup_refuses_production_database_host_before_any_change() {
  new_sandbox
  setup_apply "$FIXTURE_DB_SECRET" "$PROD_HOST"
  expect_refused
  expect_out 'refusing a production'
  expect_no_change
}

t_setup_refuses_a_production_revision_even_when_inputs_look_staging() {
  # The secret name is staging, but the secret it resolves to is production-named. Only the check on
  # the candidate revision can catch this.
  new_sandbox
  setup_apply "$FIXTURE_DB_SECRET" "$STAGING_HOST" \
    "STUB_ARN_OVERRIDE_FROM=$FIXTURE_DB_SECRET" \
    "STUB_ARN_OVERRIDE_TO=vitana/aurora/prod/postgrest-authenticator-uri"
  expect_refused
  expect_out 'refusing a production'
  expect_calls '^ecs register-task-definition' 0
}

t_setup_registers_a_staging_revision_when_the_service_is_missing() {
  new_sandbox
  setup_apply "$FIXTURE_DB_SECRET" "$STAGING_HOST"
  expect_ok
  expect_calls '^ecs register-task-definition' 1
  expect_calls '^ecs create-service' 1
  expect_payload_has "$STAGING_HOST"
  expect_payload_has "$FIXTURE_DB_SECRET"
  expect_payload_lacks 'vitana/(aurora|supabase)/prod/|vitana/aurora/rehearsal/|vitana-aurora-prod|rds!cluster'
}

t_setup_stops_when_the_service_state_cannot_be_read() {
  # The log group and the Cloud Map service exist in the stubs, so nothing changes before the service
  # state is read. The read then fails, and the script must not register a revision on that guess.
  new_sandbox
  setup_apply "$FIXTURE_DB_SECRET" "$STAGING_HOST" "STUB_ECS_DESCRIBE_RC=255" \
    "STUB_LOG_GROUP=/ecs/vitana-postgrest-aurora-staging" \
    "STUB_DNS_ARN=arn:aws:servicediscovery:eu-central-1:472838866351:service/srv-existing"
  expect_refused
  expect_out 'cannot read the ECS service state'
  expect_no_change
  expect_calls '^ecs register-task-definition' 0
}

t_setup_dry_run_changes_nothing() {
  new_sandbox
  run_env "PROXY_STAGING_DB_SECRET=$FIXTURE_DB_SECRET" "PROXY_STAGING_DB_HOST=$STAGING_HOST" \
    -- bash "$SETUP" provision
  expect_ok
  expect_out 'register-task-definition'
  expect_no_change
}

t_setup_does_not_register_a_revision_when_the_service_exists() {
  new_sandbox
  setup_apply "$FIXTURE_DB_SECRET" "$STAGING_HOST" \
    "STUB_ECS_STATUS=ACTIVE" "STUB_LOG_GROUP=/ecs/vitana-postgrest-aurora-staging" \
    "STUB_DNS_ARN=arn:aws:servicediscovery:eu-central-1:472838866351:service/srv-existing"
  expect_ok
  expect_out 'no new revision registered'
  expect_calls '^ecs register-task-definition' 0
  expect_no_change
}

t_setup_refuses_rehearsal_database_secret_before_any_change() {
  new_sandbox
  setup_apply "$REHEARSAL_DB_SECRET" "$STAGING_HOST"
  expect_refused
  expect_out 'refusing a production'
  expect_no_change
}

t_setup_refuses_the_unconfirmed_placeholder_before_any_change() {
  new_sandbox
  setup_apply "$PLACEHOLDER_DB_SECRET" "$STAGING_HOST"
  expect_refused
  expect_out 'placeholder'
  expect_no_change
}

run_all_tests
