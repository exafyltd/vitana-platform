#!/usr/bin/env bash
# Brief item 4 (review B2): staging-cutover-ecs.sh refuses a recorded, a live or an isolated-target revision that names a
# refused secret or host, before any register-task-definition or update-service. The stub answers from fixtures in this
# test's sandbox. The clean revisions are the repository's cutover fixtures with their production names moved to staging
# names. A dirty revision is a clean one with one refused name added to a secret.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

FX="$REPO_ROOT/scripts/ci/staging-db/fixtures/cutover"
GW_ARN="arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway"
PX_ARN="arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-postgrest-aurora-staging"
NET='{"awsvpcConfiguration":{"subnets":["subnet-0ff45a2051c5e5482","subnet-0c786864a28a5a821"],"securityGroups":["sg-0fbcf7b59b1f0d685"],"assignPublicIp":"DISABLED"}}'
CLIENT_SG="sg-0abc1234def567890"

expect_exit() { [ "$RC" -eq "$1" ] || fail_expect "expected exit $1, got $RC: $(tail -n 2 <<<"$OUT" | tr '\n' ' ')"; }

# ecs_run [NAME=value ...] -- <cutover script arguments>: run the real script against this sandbox's fixtures.
ecs_run() {
  local -a vars=("STUB_TD_DIR=$SANDBOX/td" "STUB_SERVICES_DIR=$SANDBOX/services")
  while [ $# -gt 0 ] && [ "$1" != -- ]; do vars+=("$1"); shift; done
  [ "${1:-}" = -- ] && shift
  run_env "${vars[@]}" -- bash "$CUTOVER_ECS" "$@"
}

cutover_setup() { mkdir -p "$SANDBOX/td" "$SANDBOX/services"; }

clean_gateway() { # <out>: the gateway fixture with its production secret names moved to staging names
  sed -e 's#vitana/supabase/prod/#vitana/gateway/staging/#g' -e 's#vitana/aurora/prod/#vitana/gateway/staging/#g' \
    "$FX/taskdef-gateway.json" > "$1"
}

clean_postgrest() { # <out>: the PostgREST fixture with its production host and secret moved to staging names
  sed -e 's#vitana/aurora/prod/#vitana/gateway/staging/#g' \
      -e 's#vitana-aurora-prod\.cluster-cfk228aiedf3\.eu-central-1\.rds\.amazonaws\.com#aurora-staging.test.invalid#g' \
    "$FX/taskdef-postgrest.json" > "$1"
}

dirty_copy() { # <clean file> <refused name> <out>: the same revision plus one secret that names the refused name
  jq --arg v "arn:aws:secretsmanager:eu-central-1:472838866351:secret:$2-AbCdEf" \
    '.containerDefinitions[0].secrets += [{"name":"REFUSED_TEST_SECRET","valueFrom":$v}]' "$1" > "$3"
}

put_revision() { # <family> <revision> <file>: the task definition the stub returns for that revision
  cp "$3" "$SANDBOX/td/$1-$2.json"
}

put_service() { # <service> <primary task definition ARN>: a stable service with one PRIMARY deployment
  jq -n --arg n "$1" --arg td "$2" --argjson net "$NET" '{services:[{serviceName:$n, status:"ACTIVE",
    desiredCount:1, runningCount:1, networkConfiguration:$net,
    deployments:[{status:"PRIMARY", taskDefinition:$td, rolloutState:"COMPLETED", desiredCount:1, runningCount:1}]}]}' \
    > "$SANDBOX/services/$1.json"
}

put_record() { # <gateway ARN> <proxy ARN>: the cutover record both services were recorded at
  jq -n --arg g "$1" --arg p "$2" --argjson net "$NET" '{cluster:"Vitana-ECS-Cluster", recorded_at:"2026-11-22T10:00:00Z",
    services:[{service:"vitana-postgrest-aurora-proxy", taskDefinition:$p, networkConfiguration:$net},
              {service:"vitana-gateway", taskDefinition:$g, networkConfiguration:$net}]}' > "$SANDBOX/record.json"
}

assert_clean() { # <file>: the fixture-derived revision names no refused name
  grep -Eq "$REFUSED_NAME_RE" "$1" && fail_expect "the clean fixture $1 still names a refused name"
  return 0
}

# A stable, clean pair: gateway 41 and proxy 7, both recorded and both live.
clean_pair() {
  clean_gateway "$SANDBOX/gw.json"; clean_postgrest "$SANDBOX/px.json"
  assert_clean "$SANDBOX/gw.json"; assert_clean "$SANDBOX/px.json"
  put_revision vitana-gateway 41 "$SANDBOX/gw.json"
  put_revision vitana-postgrest-aurora-staging 7 "$SANDBOX/px.json"
  put_service vitana-gateway "$GW_ARN:41"
  put_service vitana-postgrest-aurora-proxy "$PX_ARN:7"
  put_record "$GW_ARN:41" "$PX_ARN:7"
}

t_rollback_refuses_recorded_rehearsal_revision() {
  new_sandbox; cutover_setup; clean_pair
  dirty_copy "$SANDBOX/px.json" 'vitana/aurora/rehearsal/postgrest-authenticator-uri' "$SANDBOX/px-dirty.json"
  put_revision vitana-postgrest-aurora-staging 7 "$SANDBOX/px-dirty.json"
  ecs_run -- rollback --record "$SANDBOX/record.json"
  expect_exit 2
  expect_out 'refusing the recorded revision of vitana-postgrest-aurora-proxy'
  expect_out 'nothing was changed'
  expect_calls '^ecs update-service' 0
}

t_rollback_refuses_live_production_revision() {
  # The live gateway runs revision 42, which binds production secrets. The recorded revision 41 is clean.
  new_sandbox; cutover_setup; clean_pair
  clean_gateway "$SANDBOX/gw-live.json"
  dirty_copy "$SANDBOX/gw-live.json" 'vitana/supabase/prod/jwt-secret' "$SANDBOX/gw-live-dirty.json"
  put_revision vitana-gateway 42 "$SANDBOX/gw-live-dirty.json"
  put_service vitana-gateway "$GW_ARN:42"
  ecs_run -- rollback --record "$SANDBOX/record.json"
  expect_exit 2
  expect_out 'refusing the live revision of vitana-gateway'
  expect_calls '^ecs update-service' 0
}

t_rollback_checks_both_services_before_any_update() {
  # The gateway is clean and the proxy is not. Refusing the proxy must happen before the gateway is re-pointed.
  new_sandbox; cutover_setup; clean_pair
  dirty_copy "$SANDBOX/px.json" 'vitana-aurora-prod' "$SANDBOX/px-dirty.json"
  put_revision vitana-postgrest-aurora-staging 7 "$SANDBOX/px-dirty.json"
  ecs_run -- rollback --record "$SANDBOX/record.json"
  expect_exit 2
  expect_out 'refusing the recorded revision of vitana-postgrest-aurora-proxy'
  expect_calls '^ecs update-service' 0
}

t_rollback_refuses_revision_naming_each_refused_name() {
  # Each refused name, as the list file defines it, must be refused. The second column is the text the refusal prints.
  local pair name hit
  for pair in 'vitana/aurora/prod/postgrest-authenticator-uri|vitana/aurora/prod/' \
              'vitana/supabase/prod/jwt-secret|vitana/supabase/prod/' \
              'vitana/aurora/rehearsal/postgrest-authenticator-uri|vitana/aurora/rehearsal/' \
              'vitana-aurora-prod.cluster-x.eu-central-1.rds.amazonaws.com|vitana-aurora-prod' \
              'rds!cluster-4dab93b8-AbCdEf|rds!cluster-4dab93b8'; do
    name="${pair%%|*}"; hit="${pair#*|}"
    new_sandbox; cutover_setup; clean_pair
    dirty_copy "$SANDBOX/px.json" "$name" "$SANDBOX/px-dirty.json"
    put_revision vitana-postgrest-aurora-staging 7 "$SANDBOX/px-dirty.json"
    ecs_run -- rollback --record "$SANDBOX/record.json"
    expect_exit 2
    expect_out "\\($hit\\)"
    expect_calls '^ecs update-service' 0
  done
}

t_rollback_refuses_when_a_revision_cannot_be_read() {
  # The recorded proxy revision has no fixture, so it cannot be read. The rollback stops with exit 1 and changes nothing.
  new_sandbox; cutover_setup; clean_pair
  put_record "$GW_ARN:41" "$PX_ARN:9"
  ecs_run -- rollback --record "$SANDBOX/record.json"
  expect_exit 1
  expect_out 'cannot read the task definition of the recorded revision of vitana-postgrest-aurora-proxy'
  expect_calls '^ecs update-service' 0
}

t_rollback_accepts_clean_revisions() {
  new_sandbox; cutover_setup; clean_pair
  ecs_run -- rollback --record "$SANDBOX/record.json"
  expect_ok
  expect_calls '^ecs update-service' 2
  expect_out 'verified vitana-gateway on'
}

t_flip_refuses_recorded_production_revision() {
  # The recorded gateway revision is the production-bound fixture as it is. The flip refuses before any write.
  new_sandbox; cutover_setup; clean_pair
  put_revision vitana-gateway 41 "$FX/taskdef-gateway.json"
  ecs_run STAGING_CUTOVER_APPROVED=yes -- flip --record "$SANDBOX/record.json" --client-sg "$CLIENT_SG"
  expect_exit 2
  expect_out 'refusing the recorded revision of vitana-gateway'
  expect_calls '^ecs register-task-definition' 0
  expect_calls '^ecs update-service' 0
}

t_flip_refuses_live_production_revision() {
  # The live gateway moved to revision 42 after the record. The flip refuses before any write. The moved check runs
  # before the revision checks, so this refusal names the move. For the flip the live check is reached only when the live
  # revision equals the recorded one, and then the recorded check refuses the same revision.
  new_sandbox; cutover_setup; clean_pair
  clean_gateway "$SANDBOX/gw-live.json"
  dirty_copy "$SANDBOX/gw-live.json" 'vitana/supabase/prod/jwt-secret' "$SANDBOX/gw-live-dirty.json"
  put_revision vitana-gateway 42 "$SANDBOX/gw-live-dirty.json"
  put_service vitana-gateway "$GW_ARN:42"
  ecs_run STAGING_CUTOVER_APPROVED=yes -- flip --record "$SANDBOX/record.json" --client-sg "$CLIENT_SG"
  expect_exit 1
  expect_out 'vitana-gateway moved since it was recorded'
  expect_calls '^ecs register-task-definition' 0
  expect_calls '^ecs update-service' 0
}

t_flip_refuses_isolated_target_refused_by_transform() {
  # Both recorded and live revisions are clean. The isolated secret the flip resolves for the proxy is the production one.
  # The staging-cutover-taskdef.mjs transform refuses that ARN, because it accepts only the staging-db ARN. This test
  # proves that transform refusal. The check on the rendered target in flip is tested by
  # flip_refuses_isolated_target_that_names_production.
  new_sandbox; cutover_setup; clean_pair
  ecs_run STAGING_CUTOVER_APPROVED=yes STUB_ARN_OVERRIDE_FROM=vitana/aurora/staging-db/postgrest-authenticator-uri \
    STUB_ARN_OVERRIDE_TO=vitana/aurora/prod/postgrest-authenticator-uri -- flip --record "$SANDBOX/record.json" --client-sg "$CLIENT_SG"
  expect_exit 2
  expect_out 'is not a staging secret ARN'
  expect_out 'isolated switch refused for'
  expect_calls '^ecs register-task-definition' 0
  expect_calls '^ecs update-service' 0
}

t_flip_refuses_isolated_target_that_names_production() {
  # Guard test (review C4). The isolated switch is replaced by a copy of the script's refusal path: a stub select returns a
  # target that names production, so the transform never runs. Only the check on the rendered target in flip (refuse_names)
  # can refuse it. Without that check, flip registers and updates the proxy, and this test fails.
  new_sandbox; cutover_setup; clean_pair
  local copy="$SANDBOX/copy"
  mkdir -p "$copy"
  cp "$CUTOVER_ECS" "$REFUSED_NAMES_FILE" "$copy/"
  cat > "$copy/staging-cutover-select.sh" <<'STUB'
#!/usr/bin/env bash
# Test stub for staging-cutover-select.sh: the input revision with one production secret added.
jq '.containerDefinitions[0].secrets += [{"name":"TEST_PRODUCTION_SECRET","valueFrom":"arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/aurora/prod/postgrest-authenticator-uri-AbCdEf"}]'
STUB
  run_env "STUB_TD_DIR=$SANDBOX/td" "STUB_SERVICES_DIR=$SANDBOX/services" STAGING_CUTOVER_APPROVED=yes \
    CUTOVER_WAIT_TIMEOUT_S=5 CUTOVER_POLL_S=1 -- bash "$copy/staging-cutover-ecs.sh" flip --record "$SANDBOX/record.json" --client-sg "$CLIENT_SG"
  expect_exit 2
  expect_out 'refusing the isolated target of vitana-postgrest-aurora-proxy'
  expect_out 'nothing was changed'
  expect_calls '^ecs register-task-definition' 0
  expect_calls '^ecs update-service' 0
}

t_flip_accepts_clean_revisions() {
  new_sandbox; cutover_setup; clean_pair
  ecs_run STAGING_CUTOVER_APPROVED=yes -- flip --record "$SANDBOX/record.json" --client-sg "$CLIENT_SG"
  expect_ok
  expect_calls '^ecs register-task-definition' 2
  expect_calls '^ecs update-service' 2
  [ "$(jq '.services | length' "$SANDBOX/record.json.flipped.json" 2>/dev/null)" = 2 ] || fail_expect "the flipped record does not list two services"
}

run_all_tests
