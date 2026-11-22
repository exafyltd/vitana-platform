#!/usr/bin/env bash
# Mutation proof for the proxy-security guards (brief item 7).
#
# Each row names one guard, the edit that removes or weakens it, and the test that must catch the edit. For each row the
# script copies .github, scripts, infra and config from the repository into a fresh directory under /tmp, applies that one
# edit to the copy, and runs the named test there. A row is CAUGHT when the test reports FAIL in the copy. The working tree
# is never edited, and no mutated file is committed. The BASE rows run the unmutated copy, and both must pass.
#
#   bash scripts/aws/test-a-proxy-security/mutation-proof.sh [--rows ID,ID,...] [--out <markdown file>]
#
# Row fields are separated by |~|: ID | file | scope | old | new | runner | test | description.
#   file    path relative to the repository root, or - for none.
#   scope   text the edit must come after, or empty. With a scope, the first match of old after it is replaced. Without a
#           scope, old must occur exactly once in the file.
#   old/new literal text (not a pattern). A literal \n stands for a line break.
#   runner  bash:<test file> runs one proxy test file in scripts/aws/test-a-proxy-security. bash:run.sh runs the whole
#           proxy suite. node:<repo-relative test file> runs one node test file. node:all runs the deploy node tests.
#           none is not run.
# Exit: 0 when every row is CAUGHT, is an accepted equivalent, or is a BASE row that passes. 1 otherwise.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ONLY=""
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rows) ONLY="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# apply_edit <file> <scope> <old> <new>: changes exactly one place in <file>, or exits non-zero and changes nothing.
apply_edit() {
  ruby -e '
    path, scope, old, new = ARGV.map { |a| a.gsub("\\n", "\n") }
    s = File.read(path)
    if scope.empty?
      abort("old text occurs #{s.scan(old).size} times, want 1") unless s.scan(old).size == 1
      File.write(path, s.sub(old) { new })
    else
      i = s.index(scope) or abort("scope not found")
      j = s.index(old, i) or abort("old text not found after the scope")
      File.write(path, s[0...j] + new + s[(j + old.length)..])
    end
  ' "$1" "$2" "$3" "$4"
}

TABLE=$(cat <<'TABLE'
BASE-BASH|~|-|~|-|~|-|~|-|~|bash:run.sh|~|-|~|unmutated copy: the whole proxy harness must pass
BASE-NODE|~|-|~|-|~|-|~|-|~|node:all|~|-|~|unmutated copy: the deploy node tests must pass
M01|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|Nothing was built, pushed or registered."; exit 1; }|~|Nothing was built, pushed or registered."; exit 0; }|~|bash:test-7-dispatch-guard.sh|~|proxy_guard_refuses_kiro_test_ref|~|the first step's refusal of a non-main ref exits 0
M02|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|if [ "$DB_HOST" != "$WANT_HOST" ]; then|~|if false; then|~|bash:test-6-db-host-check.sh|~|host_mismatch_is_refused|~|host equality check removed
M03|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|[ -n "$WANT_HOST" ] || { echo|~|[ -n "$WANT_HOST" ] || true || { echo|~|bash:test-6-db-host-check.sh|~|endpoint_variable_unset_is_refused|~|empty or unset endpoint check removed
M04|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~||| { echo "::error::Cannot read the PGRST_DB_URI secret|~||| true || { echo "::error::Cannot read the PGRST_DB_URI secret|~|bash:test-6-db-host-check.sh|~|secret_read_denied_is_refused|~|a failed secret read no longer stops the job
M05|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|*host=*|*hostaddr=*) echo|~|*hostaddr=*) echo|~|bash:test-6-db-host-check.sh|~|host_override_is_refused|~|host= query check removed
M06|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|*host=*|*hostaddr=*) echo|~|*host=*) echo|~|bash:test-6-db-host-check.sh|~|hostaddr_override_is_refused|~|hostaddr= query check removed
M07|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|([^/?@:,]+)(:[0-9]+)?(/[^?]*)?|~|([^/?@:,]+)(:[0-9]+)?(,[^/?@]*)?(/[^?]*)?|~|bash:test-6-db-host-check.sh|~|multiple_hosts_are_refused|~|the grammar accepts a second host after the port (a comma), which libpq would try on failover
M08|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|postgres://*|postgresql://*) ;;|~|postgres://*|postgresql://*|*) ;;|~|bash:test-6-db-host-check.sh|~|other_scheme_is_refused|~|scheme check removed (the grammar still refuses)
M10|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|case "$DB_URI" in|~|echo "$DB_URI"; case "$DB_URI" in|~|bash:test-6-db-host-check.sh|~|secret_value_is_never_printed|~|the secret value is echoed after the read
M11|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|PGRST_DB_SECRET_ID: 'vitana/gateway/staging/postgrest-authenticator-uri'|~|PGRST_DB_SECRET_ID: 'REPLACE_WITH_OWNER_CONFIRMED_STAGING_SECRET'|~|bash:test-2-prod-refusal-workflow.sh|~|job_env_binds_verified_staging_secret_names|~|job env binds the placeholder again
M12|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|PGRST_JWT_SECRET_ID: 'vitana/gateway/staging/postgrest-jwt-secret'|~|PGRST_JWT_SECRET_ID: 'vitana/gateway/staging/supabase-jwt-secret'|~|bash:test-2-prod-refusal-workflow.sh|~|job_env_binds_verified_staging_secret_names|~|job env binds the supabase JWT name
M13|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|*REPLACE_WITH_*) echo|~|*NEVER_MATCHES_X_Y_Z*) echo|~|bash:test-2-prod-refusal-workflow.sh|~|verify_refuses_placeholder_value|~|placeholder case removed from the verify step
MC2-3|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|if [ "$(jq -r '[.containerDefinitions[].secrets[]? | select(.name == "PGRST_DB_URI") | .valueFrom] | join(",")' <<<"$NEW_DEF")" != "$SEC_DB_URI" ]; then|~|if false; then|~|bash:test-6-db-host-check.sh|~|register_refuses_a_candidate_bound_to_another_db_secret|~|the register step no longer refuses a candidate whose PGRST_DB_URI is another secret
MC1-1|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|URI_RE='^postgres(ql)?://([^/?@]*@)?|~|URI_RE='^postgres(ql)?://([^/@]*@)?|~|bash:test-6-db-host-check.sh|~|question_mark_before_at_is_refused|~|the userinfo accepts a question mark (the mismatch check still refuses the value)
MC1-2|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|(\?[^%@]*)?$'|~|(\?[^@]*)?$'|~|bash:test-6-db-host-check.sh|~|percent_escaped_host_parameter_is_refused|~|the query accepts a percent sign
MC1-3|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|(\?[^%@]*)?$'|~|(\?[^%]*)?$'|~|bash:test-6-db-host-check.sh|~|at_sign_in_query_is_refused|~|the query accepts an at sign
MC1-4|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|URI_RE='^postgres(ql)?://([^/?@]*@)?|~|URI_RE='^postgres(ql)?://([^?@]*@)?|~|bash:test-6-db-host-check.sh|~|slash_before_at_is_refused|~|the userinfo may contain a slash, so the host is read after the at sign
MC1-5|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|URI_RE='^postgres(ql)?://([^/?@]*@)?|~|URI_RE='^postgres(ql)?://([^/?]*@)?|~|bash:test-6-db-host-check.sh|~|second_at_before_host_is_refused|~|the userinfo may contain a second at sign
MC1-6|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|if [ "$DB_HOST" != "$WANT_HOST" ]; then|~|echo "PGRST_DB_URI host: $DB_HOST"; if [ "$DB_HOST" != "$WANT_HOST" ]; then|~|bash:test-6-db-host-check.sh|~|password_fragment_is_not_printed|~|the host is printed before the endpoint comparison
MC1-7|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|[[ "$DB_HOST" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || {|~|true || {|~|bash:test-6-db-host-check.sh|~|encoded_host_is_refused|~|the plain-host check is removed
MC1-8|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|if grep -Eiq "$PROD_NAME" <<<"$DB_URI"; then|~|if false; then|~|bash:test-6-db-host-check.sh|~|production_name_anywhere_in_the_value_is_refused|~|the whole-value production-name check is removed
MC1-9|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|if grep -Eiq "$PROD_NAME" <<<"$DB_URI"; then|~|if grep -Eq "$PROD_NAME" <<<"$DB_URI"; then|~|bash:test-6-db-host-check.sh|~|production_name_anywhere_in_the_value_is_refused|~|the whole-value check is case-sensitive, so an uppercase production name passes
MC2-2|~|.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml|~|-|~|get-secret-value --secret-id "$PGRST_DB_SECRET_ID" --query SecretString|~|get-secret-value --secret-id "vitana/gateway/staging/postgrest-jwt-secret" --query SecretString|~|bash:test-6-db-host-check.sh|~|verify_step_reads_only_verified_secret_names|~|the host check reads the JWT secret instead of the URI secret
M14|~|scripts/aws/setup-postgrest-aurora-proxy-staging.sh|~|-|~|SECRET_JWT="vitana/gateway/staging/postgrest-jwt-secret"|~|SECRET_JWT="vitana/gateway/staging/supabase-jwt-secret"|~|bash:test-3-setup-script.sh|~|setup_registers_postgrest_jwt_secret|~|the setup script registers the supabase JWT name
M15|~|scripts/aws/setup-postgrest-aurora-proxy-staging.sh|~|-|~|SECRET_DB_URI="${PROXY_STAGING_DB_SECRET:-vitana/gateway/staging/postgrest-authenticator-uri}"|~|SECRET_DB_URI="${PROXY_STAGING_DB_SECRET:-}"|~|bash:test-3-setup-script.sh|~|setup_defaults_to_verified_db_secret|~|the verified database secret default is removed
M16|~|scripts/aws/setup-postgrest-aurora-proxy-staging.sh|~|-|~|PROD_PATTERN='vitana/(aurora|supabase)/prod/|vitana/aurora/rehearsal/|~|PROD_PATTERN='vitana/(aurora|supabase)/prod/|~|bash:test-3-setup-script.sh|~|setup_refuses_rehearsal_database_secret_before_any_change|~|the rehearsal name is removed from PROD_PATTERN
M17|~|scripts/eng/deploy/deploy-ecs.mjs|~|-|~|vitana\/aurora\/rehearsal\/||~||~|node:scripts/eng/deploy/test-a/production-credential-gate.test.mjs|~|rehearsal_clone_arn_is_refused_in_shadow_and_live|~|the rehearsal name is removed from PROD_CREDENTIAL_RE
M18|~|scripts/eng/deploy/deploy-ecs.mjs|~|-|~||vitana-aurora-prod|rds|~||rds|~|node:scripts/eng/deploy/test-a/production-credential-gate.test.mjs|~|each_refused_name_is_detected|~|the vitana-aurora-prod literal is removed from PROD_CREDENTIAL_RE
M19|~|scripts/eng/deploy/deploy-ecs.mjs|~|-|~||vitana\/aurora\/rehearsal\/|vitana-aurora-prod|~||secret:vitana\/aurora\/rehearsal\/|vitana-aurora-prod|~|node:scripts/eng/deploy/test-a/production-credential-gate.test.mjs|~|rehearsal_bare_name_in_env_is_refused|~|the rehearsal name is anchored to secret: so a bare name passes
M20|~|scripts/eng/deploy/deploy-ecs.mjs|~|-|~|  assertNoProductionCredentials(describeTaskDefinition(deps.run, state.captured_task_definition), t, 'rollback');|~|  void 0;|~|node:scripts/eng/deploy/test-a/production-credential-gate.test.mjs|~|rollback_refuses_captured_rehearsal_revision|~|the rollback check of the captured revision is removed
M21|~|scripts/eng/deploy/deploy-ecs.mjs|~|-|~|  assertNoProductionCredentials(describeTaskDefinition(deps.run, svc.taskDefinition), t, 'rollback');|~|  void 0;|~|node:scripts/eng/deploy/test-a/production-credential-gate.test.mjs|~|rollback_refuses_live_production_revision|~|the rollback check of the live revision is removed
M22|~|scripts/eng/deploy/deploy-ecs.mjs|~|-|~|  assertNoProductionCredentials(describeTaskDefinition(deps.run, state.captured_task_definition), t, 'rollback');\n  assertNoProductionCredentials(describeTaskDefinition(deps.run, svc.taskDefinition), t, 'rollback');\n  await repoint(t, deps, state, opts, `deploy job ended at phase ${state.phase}`);|~|  await repoint(t, deps, state, opts, `deploy job ended at phase ${state.phase}`);\n  assertNoProductionCredentials(describeTaskDefinition(deps.run, state.captured_task_definition), t, 'rollback');\n  assertNoProductionCredentials(describeTaskDefinition(deps.run, svc.taskDefinition), t, 'rollback');|~|node:scripts/eng/deploy/test-a/production-credential-gate.test.mjs|~|rollback_refuses_captured_rehearsal_revision|~|both rollback checks run after the repoint
M23|~|scripts/aws/staging-cutover-ecs.sh|~|-|~|refuse_unsafe_revision "$td" "the recorded revision of $s"|~|:|~|bash:test-5-unsafe-rollback.sh|~|flip_refuses_recorded_production_revision|~|the recorded-revision check is removed from check_revisions
M23n|~|scripts/aws/staging-cutover-ecs.sh|~|-|~|refuse_unsafe_revision "$td" "the recorded revision of $s"|~|:|~|node:scripts/ci/staging-db/cutover-ecs.test.mjs|~|ecs: verify fails when a service is not on the expected revision|~|the recorded-revision check is removed (the OD-1 rollback assertion in cutover-ecs.test.mjs)
M24|~|scripts/aws/staging-cutover-ecs.sh|~|-|~|refuse_unsafe_revision "$live" "the live revision of $s"|~|:|~|bash:test-5-unsafe-rollback.sh|~|rollback_refuses_live_production_revision|~|the live-revision check is removed from check_revisions
M25|~|scripts/aws/staging-cutover-ecs.sh|~|-|~|  rollback)\n    read_record\n    check_account\n    check_revisions "$record"|~|  rollback)\n    read_record\n    check_account|~|bash:test-5-unsafe-rollback.sh|~|rollback_checks_both_services_before_any_update|~|rollback no longer checks revisions before its update loop
M26|~|scripts/aws/staging-cutover-ecs.sh|~|-|~|    check_revisions "$record"\n    for s in "$LIVE_PROXY" "$LIVE_GATEWAY"; do|~|    for s in "$LIVE_PROXY" "$LIVE_GATEWAY"; do|~|bash:test-5-unsafe-rollback.sh|~|flip_refuses_recorded_production_revision|~|the flip no longer runs check_revisions before its first write
M27|~|scripts/aws/staging-cutover-ecs.sh|~|-|~|-|~|-|~|none|~|-|~|EQUIVALENT: no flip-only edit exists, because check_revisions is shared with rollback (M24). The flip's moved-since-record check runs first, so a flip result does not change without the live check. Accepted in review-2.
M28|~|scripts/aws/staging-cutover-refused-names.txt|~|-|~|vitana/aurora/rehearsal/|~||~|bash:test-5-unsafe-rollback.sh|~|rollback_refuses_revision_naming_each_refused_name|~|the rehearsal line is removed from the refused-names list
M29|~|scripts/aws/staging-cutover-refused-names.txt|~|-|~|vitana-aurora-prod|~||~|bash:test-5-unsafe-rollback.sh|~|rollback_refuses_revision_naming_each_refused_name|~|the vitana-aurora-prod line is removed from the refused-names list
M30|~|scripts/aws/staging-cutover-refused-names.txt|~|-|~|vitana/(aurora|supabase)/prod/|~||~|bash:test-5-unsafe-rollback.sh|~|rollback_refuses_revision_naming_each_refused_name|~|the production-prefix line is removed from the refused-names list
M31|~|scripts/aws/staging-cutover-refused-names.txt|~|-|~|rds!cluster-4dab93b8|~||~|bash:test-5-unsafe-rollback.sh|~|rollback_refuses_revision_naming_each_refused_name|~|the cluster line is removed from the refused-names list
M28b|~|scripts/aws/staging-cutover-refused-names.txt|~|-|~|vitana/aurora/rehearsal/|~||~|bash:test-8-refusal-list.sh|~|refusal_list_keeps_every_production_literal|~|the rehearsal line is removed (list side)
M29b|~|scripts/aws/staging-cutover-refused-names.txt|~|-|~|vitana-aurora-prod|~||~|bash:test-8-refusal-list.sh|~|refusal_list_keeps_every_production_literal|~|the vitana-aurora-prod line is removed (list side)
M30b|~|scripts/aws/staging-cutover-refused-names.txt|~|-|~|vitana/(aurora|supabase)/prod/|~||~|bash:test-8-refusal-list.sh|~|refusal_list_keeps_every_production_literal|~|the production-prefix line is removed (list side)
M31b|~|scripts/aws/staging-cutover-refused-names.txt|~|-|~|rds!cluster-4dab93b8|~||~|bash:test-8-refusal-list.sh|~|refusal_list_keeps_every_production_literal|~|the cluster line is removed (list side)
MT|~|scripts/aws/staging-cutover-ecs.sh|~|-|~|refuse_names "$new" "the isolated target of $s"|~|:|~|bash:test-5-unsafe-rollback.sh|~|flip_refuses_isolated_target_that_names_production|~|the check on the rendered isolated target is removed
M32|~|.github/workflows/AWS-STAGE-CUTOVER.yml|~|-|~|[ "$REF" = refs/heads/main ] || { echo "::error::Refused: run from main only, not $REF."; fail=1; }|~|:|~|bash:test-7-dispatch-guard.sh|~|cutover_gate_refuses_kiro_test_ref|~|the gate's main-ref check is removed
M33|~|.github/workflows/AWS-STAGE-CUTOVER.yml|~|name: Manual rollback to a recorded flip|~|needs: gate|~|needs: flip|~|bash:test-7-dispatch-guard.sh|~|flip_and_rollback_need_the_gate|~|the rollback job no longer needs the gate
M34|~|.github/workflows/AWS-STAGE-CUTOVER.yml|~|- name: Guard (--enforce) over the cutover scripts|~|          role-to-assume: ${{ vars.AWS_STAGING_ROLE_ARN }}|~|          role-to-assume: ${{ vars.AWS_STAGING_ROLE_ARN }}\n          aws-access-key-id: ${{ secrets.AWS_STAGING_KEY }}|~|bash:test-1-static-credentials.sh|~|cutover_workflow_reads_no_static_aws_keys|~|a static access key is added to the cutover configure step
M35|~|infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml|~|"deploy-staging:postgrest-aurora-proxy":|~|$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == \"push\"|~|$CI_PIPELINE_SOURCE == \"push\"|~|node:scripts/eng/deploy/test-a/gitlab-proxy-jobs.test.mjs|~|proxy_jobs_run_only_for_default_branch_push|~|the deploy proxy job's rule drops the default-branch clause
M36|~|infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml|~|"rollback-staging:postgrest-aurora-proxy":|~|$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == \"push\"|~|$CI_PIPELINE_SOURCE == \"web\" || $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == \"push\"|~|node:scripts/eng/deploy/test-a/gitlab-proxy-jobs.test.mjs|~|proxy_jobs_run_only_for_default_branch_push|~|the rollback proxy job's rule also runs for web pipelines
M37|~|infra/gitlab-engineering/ci/platform-delivery.gitlab-ci.yml|~|"rollback-staging:postgrest-aurora-proxy":|~|extends: ".rollback-staging"|~|extends: ".deploy-staging"|~|node:scripts/eng/deploy/test-a/gitlab-proxy-jobs.test.mjs|~|proxy_jobs_extend_gated_templates|~|the rollback proxy job extends the deploy template
TABLE
)

RESULTS=$(mktemp "${TMPDIR:-/tmp}/proxy-mutation-results.XXXXXX")
trap 'rm -f "$RESULTS"' EXIT

# run_row <id> <file> <scope> <old> <new> <runner> <test> <description>: one copy, one edit, one test run. Appends a result line.
run_row() {
  local id="$1" file="$2" scope="$3" old="$4" new="$5" runner="$6" test="$7" desc="$8"
  local tmp copy kind target out result observed d
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/proxy-mutation.XXXXXX")
  copy="$tmp/repo"
  mkdir -p "$copy" "$tmp/tests"
  for d in .github scripts infra config; do cp -a "$REPO/$d" "$copy/"; done
  kind="${runner%%:*}"; target="${runner#*:}"
  result=""; observed=""
  if [ "$kind" = none ]; then
    result="EQUIVALENT (accepted, not run)"; observed="$desc"
  elif [ "$file" != - ]; then
    if ! apply_edit "$copy/$file" "$scope" "$old" "$new" 2>"$tmp/edit.err"; then
      result="EDIT-NOT-APPLIED"; observed=$(head -n 1 "$tmp/edit.err")
    fi
  fi
  if [ -z "$result" ]; then
    case "$kind" in
      bash)
        if [ "$target" = run.sh ]; then
          out=$(TESTS_TMP="$tmp/tests" bash "$copy/scripts/aws/test-a-proxy-security/run.sh" 2>&1)
          if grep -Eq '^SUMMARY pass=[0-9]+ fail=0$' <<<"$out"; then result="BASE PASS"; else result="BASE FAIL"; fi
          observed=$(grep '^SUMMARY' <<<"$out" | tail -n 1)
        else
          out=$(TESTS_TMP="$tmp/tests" bash "$copy/scripts/aws/test-a-proxy-security/$target" 2>&1)
          if grep -Eq "^FAIL ${test} \(" <<<"$out"; then result="CAUGHT"; else result="MISSED"; fi
          observed=$(grep -E "^FAIL ${test} " <<<"$out" | head -n 1)
          [ -n "$observed" ] || observed="no FAIL line for ${test}"
        fi ;;
      node)
        if [ "$target" = all ]; then
          out=$(node --test "$copy"/scripts/eng/deploy/*.test.mjs "$copy"/scripts/eng/deploy/test-a/*.test.mjs 2>&1)
          if grep -Eq '^# fail 0$' <<<"$out"; then result="BASE PASS"; else result="BASE FAIL"; fi
          observed=$(grep -E '^# (tests|pass|fail) ' <<<"$out" | paste -sd' ' -)
        else
          out=$(node --test "$copy/$target" 2>&1)
          if grep -Eq "^not ok [0-9]+ - ${test}\$" <<<"$out"; then result="CAUGHT"; else result="MISSED"; fi
          observed=$(grep -E "^not ok [0-9]+ - ${test}\$" <<<"$out" | head -n 1)
          [ -n "$observed" ] || observed="no 'not ok' line for ${test}"
        fi ;;
    esac
    [ -n "$result" ] || result="MISSED"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$file" "$test" "$result" "$observed" "$desc" >> "$RESULTS"
  rm -rf "$tmp"
}

while IFS= read -r line; do
  [ -n "$line" ] || continue
  fields=(); rest="$line"
  while [[ "$rest" == *'|~|'* ]]; do fields+=("${rest%%|~|*}"); rest="${rest#*|~|}"; done
  fields+=("$rest")
  [ "${#fields[@]}" -eq 8 ] || { echo "malformed row: ${fields[0]}" >&2; printf '%s\t-\t-\tMALFORMED\t-\t-\n' "${fields[0]}" >> "$RESULTS"; continue; }
  if [ -n "$ONLY" ] && [[ ",$ONLY," != *",${fields[0]},"* ]]; then continue; fi
  run_row "${fields[@]}"
done <<<"$TABLE"

table=$(awk -F'\t' 'BEGIN { print "| ID | File | Test that must FAIL | Result | Observed | Edit |"; print "|---|---|---|---|---|---|" }
  { gsub(/\|/, "\\|", $5); gsub(/\|/, "\\|", $6); printf "| %s | %s | %s | %s | %s | %s |\n", $1, $2, $3, $4, $5, $6 }' "$RESULTS")
bad=$(awk -F'\t' '$4 != "CAUGHT" && $4 != "BASE PASS" && $4 !~ /^EQUIVALENT/ { n++ } END { print n + 0 }' "$RESULTS")
head_sha=$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)
dirty=$(git -C "$REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
report=$(printf '# Mutation proof\n\nHEAD %s, uncommitted paths in the working tree: %s. Each row ran on a copy of .github, scripts, infra and config.\n\n%s\n\nRows that are neither CAUGHT, BASE PASS nor EQUIVALENT: %s.\n' "$head_sha" "$dirty" "$table" "$bad")
if [ -n "$OUT" ]; then printf '%s\n' "$report" > "$OUT"; fi
printf '%s\n' "$report"
[ "$bad" -eq 0 ]
