#!/usr/bin/env bash
# Change 2 (workflow): production secret names and database hosts are refused on the deploy path.
# The register step runs with the candidate revision from a describe-task-definition fixture, so the
# refusal is tested on the same revision the real step would register.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# register_run <task definition file> [NAME=value ...]: run the real register step.
register_run() {
  local td="$1"; shift
  step_run "Register task-definition revision + roll the service" "$SANDBOX/register.sh" || return 1
  run_env "STUB_TD_FILE=$td" "STAGING_DATA_PLANE=" "STAGING_CUTOVER_APPROVED=" \
    "PGRST_DB_SECRET_ID=$FIXTURE_DB_SECRET" "PGRST_JWT_SECRET_ID=$STAGING_JWT_SECRET" \
    "STAGING_ACCOUNT_ID=$STAGING_ACCOUNT" "TARGET_AWS_REGION=eu-central-1" "$@" \
    -- bash "$SANDBOX/register.sh"
}

# verify_run [NAME=value ...]: run the real credential verification step.
verify_run() {
  step_run "Verify staging credentials before any AWS change" "$SANDBOX/verify.sh" || return 1
  run_env "STAGING_ROLE_ARN=$STAGING_ROLE_ARN" "STAGING_ACCOUNT_ID=$STAGING_ACCOUNT" \
    "PGRST_DB_SECRET_ID=$FIXTURE_DB_SECRET" "PGRST_JWT_SECRET_ID=$STAGING_JWT_SECRET" \
    "TARGET_AWS_REGION=eu-central-1" "$@" -- bash "$SANDBOX/verify.sh"
}

expect_register_refused() {
  expect_refused
  expect_out 'Nothing was registered'
  expect_calls '^ecs register-task-definition' 0
  expect_calls '^ecs update-service' 0
}

t_register_refuses_production_database_host() {
  new_sandbox
  write_td_fixture "$SANDBOX/td.json" \
    '(.containerDefinitions[] | select(.name == "postgrest") | .environment[] | select(.name == "PGRST_DB_HOST") | .value) |= "vitana-aurora-prod.test.invalid"'
  register_run "$SANDBOX/td.json" || { fail_expect "step 'Register task-definition revision + roll the service' is missing"; return 0; }
  expect_register_refused
}

t_register_refuses_production_database_secret_path() {
  new_sandbox
  write_td_fixture "$SANDBOX/td.json" \
    '(.containerDefinitions[] | select(.name == "proxy") | .secrets) = [{"name":"PGRST_DB_URI","valueFrom":"arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/aurora/prod/postgrest-authenticator-uri-AbCdEf"}]'
  register_run "$SANDBOX/td.json" || { fail_expect "step is missing"; return 0; }
  expect_register_refused
}

t_register_refuses_production_supabase_secret_path() {
  new_sandbox
  write_td_fixture "$SANDBOX/td.json" \
    '(.containerDefinitions[] | select(.name == "proxy") | .secrets) = [{"name":"PGRST_JWT_SECRET","valueFrom":"arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/supabase/prod/jwt-secret-AbCdEf"}]'
  register_run "$SANDBOX/td.json" || { fail_expect "step is missing"; return 0; }
  expect_register_refused
}

t_register_refuses_production_cluster_master_secret() {
  new_sandbox
  write_td_fixture "$SANDBOX/td.json" \
    '(.containerDefinitions[] | select(.name == "proxy") | .secrets) = [{"name":"PGRST_DB_URI","valueFrom":"arn:aws:secretsmanager:eu-central-1:472838866351:secret:rds!cluster-4dab93b8-AbCdEf"}]'
  register_run "$SANDBOX/td.json" || { fail_expect "step is missing"; return 0; }
  expect_register_refused
}

t_register_refuses_when_the_db_secret_name_is_production() {
  new_sandbox
  write_td_fixture "$SANDBOX/td.json"
  register_run "$SANDBOX/td.json" "PGRST_DB_SECRET_ID=vitana/aurora/prod/postgrest-authenticator-uri" \
    || { fail_expect "step is missing"; return 0; }
  expect_register_refused
}

t_register_accepts_a_staging_revision() {
  new_sandbox
  write_td_fixture "$SANDBOX/td.json"
  register_run "$SANDBOX/td.json" || { fail_expect "step is missing"; return 0; }
  expect_ok
  expect_calls '^ecs register-task-definition' 1
  expect_calls '^ecs update-service' 1
}

t_verify_refuses_production_database_secret_name() {
  new_sandbox
  verify_run "PGRST_DB_SECRET_ID=vitana/aurora/prod/postgrest-authenticator-uri" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'production secret name'
  expect_calls '^sts ' 0
}

t_verify_refuses_production_supabase_secret_name() {
  new_sandbox
  verify_run "PGRST_JWT_SECRET_ID=vitana/supabase/prod/jwt-secret" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'production secret name'
  expect_calls '^sts ' 0
}

t_register_refuses_rehearsal_database_secret_path() {
  # The candidate revision names the rehearsal clone's secret ARN in the proxy container.
  new_sandbox
  write_td_fixture "$SANDBOX/td.json" \
    '(.containerDefinitions[] | select(.name == "proxy") | .secrets) = [{"name":"PGRST_DB_URI","valueFrom":"arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/aurora/rehearsal/postgrest-authenticator-uri-AbCdEf"}]'
  register_run "$SANDBOX/td.json" || { fail_expect "step is missing"; return 0; }
  expect_register_refused
}

t_register_refuses_when_the_db_secret_name_is_rehearsal() {
  new_sandbox
  write_td_fixture "$SANDBOX/td.json"
  register_run "$SANDBOX/td.json" "PGRST_DB_SECRET_ID=$REHEARSAL_DB_SECRET" \
    || { fail_expect "step is missing"; return 0; }
  expect_register_refused
}

t_verify_refuses_rehearsal_database_secret_name() {
  new_sandbox
  verify_run "PGRST_DB_SECRET_ID=$REHEARSAL_DB_SECRET" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'production secret name'
  expect_calls '^sts ' 0
}

t_job_env_binds_verified_staging_secret_names() {
  # Every step reads these names from the job env. They must be the two verified names, and the
  # workflow must not name the old JWT secret anywhere.
  new_sandbox
  local env_json
  env_json=$(ruby "$STEPS_RB" "$WORKFLOW" job-env) || { fail_expect "cannot read the job env"; return 0; }
  jq -e --arg db "$STAGING_DB_SECRET" --arg jwt "$STAGING_JWT_SECRET" \
    '.PGRST_DB_SECRET_ID == $db and .PGRST_JWT_SECRET_ID == $jwt' <<<"$env_json" >/dev/null \
    || fail_expect "job env does not bind the two verified staging secret names: $(jq -c '{PGRST_DB_SECRET_ID, PGRST_JWT_SECRET_ID}' <<<"$env_json")"
  grep -q 'supabase-jwt-secret' "$WORKFLOW" && fail_expect "the workflow still names supabase-jwt-secret"
  return 0
}

t_verify_refuses_placeholder_value() {
  # A placeholder value stops the verify step before any AWS call, even when every other input is set.
  new_sandbox
  verify_run "PGRST_DB_SECRET_ID=$PLACEHOLDER_DB_SECRET" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'unconfirmed placeholder'
  expect_calls '^sts ' 0
  expect_calls '^secretsmanager ' 0
}

t_verify_refuses_a_secret_name_that_names_the_production_host() {
  new_sandbox
  verify_run "PGRST_DB_SECRET_ID=vitana-aurora-prod/postgrest-authenticator-uri" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'production secret name'
  expect_calls '^sts ' 0
}

t_verify_refuses_the_production_cluster_master_secret_name() {
  new_sandbox
  verify_run "PGRST_DB_SECRET_ID=rds!cluster-4dab93b8-AbCdEf" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'production secret name'
  expect_calls '^sts ' 0
}

run_all_tests
