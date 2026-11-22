#!/usr/bin/env bash
# Brief item 6 (B6): the verify step reads the PGRST_DB_URI secret value once, compares the host inside it
# with the owner-confirmed staging writer endpoint, prints only that host, and fails closed on any read or
# parse failure. The stub answers that one read with a fake URI (FAKE-NOT-A-SECRET is test data).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# db_host_check <endpoint> [NAME=value ...]: run the real verify step. An endpoint of UNSET leaves the
# writer endpoint variable out of the environment. An empty endpoint sets it to the empty string.
db_host_check() {
  local endpoint="$1"; shift
  local -a extra=()
  [ "$endpoint" = UNSET ] || extra=("STAGING_WRITER_ENDPOINT=$endpoint")
  step_run "Verify staging credentials before any AWS change" "$SANDBOX/verify.sh" || return 1
  run_env "STAGING_ROLE_ARN=$STAGING_ROLE_ARN" "STAGING_ACCOUNT_ID=$STAGING_ACCOUNT" \
    "PGRST_DB_SECRET_ID=$STAGING_DB_SECRET" "PGRST_JWT_SECRET_ID=$STAGING_JWT_SECRET" \
    "TARGET_AWS_REGION=eu-central-1" "${extra[@]}" "$@" -- bash "$SANDBOX/verify.sh"
}

# expect_no_secret_value: the output of the last run contains neither the fake password nor the URI.
expect_no_secret_value() {
  if grep -q 'FAKE-NOT-A-SECRET' <<<"$OUT"; then fail_expect "the secret value was printed"; fi
  if grep -qF "$FAKE_DB_URI" <<<"$OUT"; then fail_expect "the database URI was printed"; fi
  return 0
}

# uri_for <authority and query>: a postgres URI with the fake password, for the STUB_DB_URI override.
uri_for() { printf 'postgresql://authenticator:FAKE-NOT-A-SECRET@%s' "$1"; }

t_host_matches_endpoint_passes() {
  new_sandbox
  db_host_check "$STAGING_HOST" || { fail_expect "verify step is missing"; return 0; }
  expect_ok
  expect_out 'PGRST_DB_URI host: aurora-staging.test.invalid'
  expect_out 'matched the confirmed writer endpoint'
  expect_calls '^secretsmanager get-secret-value' 1
  expect_no_secret_value
}

t_host_mismatch_is_refused() {
  new_sandbox
  db_host_check "other-writer.test.invalid" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'does not equal the confirmed staging writer endpoint'
  expect_no_secret_value
}

t_endpoint_variable_unset_is_refused() {
  new_sandbox
  db_host_check UNSET || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'writer endpoint is not set'
  expect_calls '^secretsmanager get-secret-value' 0
  expect_no_secret_value
}

t_endpoint_variable_empty_is_refused() {
  new_sandbox
  db_host_check "" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'writer endpoint is not set'
  expect_calls '^secretsmanager get-secret-value' 0
}

t_secret_read_denied_is_refused() {
  # The AWS CLI error text also names GetSecretValue, so the step's own message is what must match.
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_GET_SECRET_DENIED=1" || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'Cannot read the PGRST_DB_URI secret for the host check'
  expect_out 'secretsmanager:GetSecretValue'
  expect_no_secret_value
}

t_host_override_is_refused() {
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=$(uri_for "${STAGING_HOST}:5432/vitana?sslmode=require&host=other-writer.test.invalid")" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'host or hostaddr in its query string'
  expect_no_secret_value
}

t_hostaddr_override_is_refused() {
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=$(uri_for "${STAGING_HOST}:5432/vitana?hostaddr=10.0.0.9")" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'host or hostaddr in its query string'
  expect_no_secret_value
}

t_multiple_hosts_are_refused() {
  # The first host is the endpoint and the second is not production, so only the comma check can refuse this.
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=$(uri_for "${STAGING_HOST}:5432,other-host.test.invalid:5432/vitana")" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'more than one host'
  expect_no_secret_value
}

t_encoded_host_is_refused() {
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=$(uri_for "%2Fvar%2Frun%2Fpostgresql:5432/vitana")" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'encoded or bracketed host'
  expect_no_secret_value
}

t_other_scheme_is_refused() {
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=mysql://authenticator:FAKE-NOT-A-SECRET@${STAGING_HOST}:3306/vitana" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'not a postgres URI'
  expect_no_secret_value
}

t_production_host_is_refused() {
  # The endpoint is staging and the URI names production, so the production-name check on the host must refuse.
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=$(uri_for "${PROD_HOST}:5432/vitana?sslmode=require")" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'names a production resource'
  expect_no_secret_value
}

t_production_endpoint_is_refused() {
  # The endpoint and the URI both name production. The host is production-named, so it is refused.
  new_sandbox
  db_host_check "$PROD_HOST" "STUB_DB_URI=$(uri_for "${PROD_HOST}:5432/vitana?sslmode=require")" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'names a production resource'
  expect_no_secret_value
}

t_secret_value_is_never_printed() {
  # Checked on a passing run and on a refused run: neither prints the value.
  new_sandbox
  db_host_check "$STAGING_HOST" || { fail_expect "verify step is missing"; return 0; }
  expect_ok
  expect_no_secret_value
  db_host_check "other-writer.test.invalid" || return 0
  expect_refused
  expect_no_secret_value
}

t_step_binds_the_owner_endpoint_variable() {
  new_sandbox
  local json
  json=$(step_json "Verify staging credentials before any AWS change") || { fail_expect "verify step is missing"; return 0; }
  jq -e '.env.STAGING_WRITER_ENDPOINT == "${{ vars.STAGING_AURORA_WRITER_ENDPOINT }}"' <<<"$json" >/dev/null \
    || fail_expect "the verify step does not bind vars.STAGING_AURORA_WRITER_ENDPOINT"
}

run_all_tests
