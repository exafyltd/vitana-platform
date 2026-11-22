#!/usr/bin/env bash
# Brief item 6 (B6): the verify step reads the PGRST_DB_URI secret value once, compares the host inside it
# with the owner-confirmed staging writer endpoint, prints only that host, and fails closed on any read or
# parse failure. The stub answers that one read with a fake URI (FAKE-NOT-A-SECRET is test data).
# The step reads only the verified secret, and it refuses every data plane except unset or shared (review C2).
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

# expect_no_host_line: the last run printed no host line, so no host came from a value the check refused.
expect_no_host_line() {
  if grep -q 'PGRST_DB_URI host:' <<<"$OUT"; then fail_expect "a host line was printed for a refused value"; fi
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
  expect_out 'does not name exactly one host'
  expect_no_host_line
  expect_no_secret_value
}

t_encoded_host_is_refused() {
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=$(uri_for "%2Fvar%2Frun%2Fpostgresql:5432/vitana")" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'not a plain host name'
  expect_no_host_line
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
  expect_out 'names a production'
  expect_no_secret_value
}

t_production_endpoint_is_refused() {
  # The endpoint and the URI both name production. The host is production-named, so it is refused.
  new_sandbox
  db_host_check "$PROD_HOST" "STUB_DB_URI=$(uri_for "${PROD_HOST}:5432/vitana?sslmode=require")" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'names a production'
  expect_no_secret_value
}

t_production_name_anywhere_in_the_value_is_refused() {
  # The endpoint is staging and the host is staging, so only the whole-value check can refuse these. The names sit in the
  # query, in the path, and in uppercase in the query. None prints the value or a host.
  local uri
  for uri in "$(uri_for "${STAGING_HOST}:5432/vitana?application_name=vitana-aurora-prod")" \
             "$(uri_for "${STAGING_HOST}:5432/vitana/aurora/rehearsal/clone")" \
             "$(uri_for "${STAGING_HOST}:5432/vitana?application_name=VITANA-AURORA-PROD")"; do
    new_sandbox
    db_host_check "$STAGING_HOST" "STUB_DB_URI=$uri" || { fail_expect "verify step is missing"; return 0; }
    expect_refused
    expect_out 'names a production or rehearsal resource'
    expect_no_host_line
    expect_no_secret_value
  done
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

t_step_binds_the_data_plane_variable() {
  new_sandbox
  local json
  json=$(step_json "Verify staging credentials before any AWS change") || { fail_expect "verify step is missing"; return 0; }
  jq -e '.env.STAGING_DATA_PLANE == "${{ vars.STAGING_DATA_PLANE }}"' <<<"$json" >/dev/null \
    || fail_expect "the verify step does not bind vars.STAGING_DATA_PLANE"
}

# Parser forms from review C1. Each one is refused, and the refusal prints no host.

t_question_mark_before_at_is_refused() {
  # libpq keeps a ? that comes before the @ in the userinfo, so the host it connects to is the one after the @.
  local uri
  for uri in 'postgresql://aurora-staging.test.invalid?x@prod-host.test.invalid/vitana' \
             'postgresql://aurora-staging.test.invalid?authenticator:FAKE-NOT-A-SECRET@prod-host.test.invalid:5432/vitana'; do
    new_sandbox
    db_host_check "$STAGING_HOST" "STUB_DB_URI=$uri" || { fail_expect "verify step is missing"; return 0; }
    expect_refused
    expect_out 'does not name exactly one host'
    expect_no_host_line
    expect_no_secret_value
  done
}

t_percent_escaped_host_parameter_is_refused() {
  # The query check matches only the literal host=, so a %68ost= spelling would pass it. The % sign itself is refused.
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=$(uri_for "${STAGING_HOST}:5432/vitana?%68ost=prod-host.test.invalid")" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'does not name exactly one host'
  expect_no_host_line
  expect_no_secret_value
}

t_second_at_before_host_is_refused() {
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=postgresql://authenticator:pa@ss@${STAGING_HOST}:5432/vitana" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'does not name exactly one host'
  expect_no_host_line
}

t_slash_before_at_is_refused() {
  # A / comes before the @, so libpq reads no userinfo and connects to other-writer. The endpoint is the host after the @.
  # The check must refuse it. Reading the host after the last @ would accept it.
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=postgresql://other-writer.test.invalid/x@${STAGING_HOST}/vitana" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'does not equal the confirmed staging writer endpoint'
  expect_no_host_line
}

t_password_fragment_is_not_printed() {
  # authenticator:pa@ss/vitana reads as password pa and host ss. The host is not the endpoint, so nothing derived from the
  # value is printed. Printing ss would show part of a password.
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=postgresql://authenticator:pa@ss/vitana" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'does not equal the confirmed staging writer endpoint'
  expect_no_host_line
}

t_at_sign_in_query_is_refused() {
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=$(uri_for "${STAGING_HOST}:5432/vitana?x=a@prod-host.test.invalid")" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'does not name exactly one host'
  expect_no_host_line
  expect_no_secret_value
}

t_percent_encoded_password_passes() {
  # Control: a password whose ? / @ % are percent-encoded passes, and the password is not printed.
  new_sandbox
  db_host_check "$STAGING_HOST" "STUB_DB_URI=postgresql://authenticator:pa%3Fss%2Fx%40y%25@${STAGING_HOST}:5432/vitana?sslmode=require" \
    || { fail_expect "verify step is missing"; return 0; }
  expect_ok
  expect_out 'PGRST_DB_URI host: aurora-staging.test.invalid'
  if grep -q 'pa%3Fss' <<<"$OUT"; then fail_expect "the password was printed"; fi
}

# Data plane (review C2): the check reads only the verified secret, so every plane except unset or shared is refused.

t_isolated_plane_is_refused_before_any_read() {
  # The isolated plane binds a database secret this check does not read. The refusal comes before any AWS call.
  new_sandbox
  db_host_check "$STAGING_HOST" STAGING_DATA_PLANE=isolated || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'must be unset or shared'
  expect_calls '^sts get-caller-identity' 0
  expect_calls '^secretsmanager' 0
}

t_unknown_data_plane_is_refused() {
  new_sandbox
  db_host_check "$STAGING_HOST" STAGING_DATA_PLANE=Isolated || { fail_expect "verify step is missing"; return 0; }
  expect_refused
  expect_out 'must be unset or shared'
  expect_calls '^secretsmanager' 0
}

t_shared_plane_reads_the_verified_name() {
  # Control: an explicit shared plane reads the verified secret once and passes.
  new_sandbox
  db_host_check "$STAGING_HOST" STAGING_DATA_PLANE=shared || { fail_expect "verify step is missing"; return 0; }
  expect_ok
  expect_out 'PGRST_DB_URI host: aurora-staging.test.invalid'
  expect_calls "^secretsmanager get-secret-value --secret-id $STAGING_DB_SECRET " 1
  expect_no_secret_value
}

t_verify_step_reads_only_verified_secret_names() {
  # The verify step names no staging secret other than the verified ones. Its one read is the verified PGRST_DB_URI secret.
  new_sandbox
  step_run "Verify staging credentials before any AWS change" "$SANDBOX/verify-check.sh" \
    || { fail_expect "verify step is missing"; return 0; }
  if grep -q 'vitana/aurora/staging' "$SANDBOX/verify-check.sh"; then fail_expect "the verify step names a non-verified staging secret"; fi
  grep -Fq 'get-secret-value --secret-id "$PGRST_DB_SECRET_ID" --query SecretString' "$SANDBOX/verify-check.sh" \
    || fail_expect "the host check does not read PGRST_DB_SECRET_ID"
}

run_all_tests
