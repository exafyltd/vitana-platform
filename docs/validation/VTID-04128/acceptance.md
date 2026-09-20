# VTID-04128 — Acceptance

Stop `AWS-PROD-DEPLOY-GATEWAY.yml` from unconditionally re-pinning
`FEATURE_ORB_GREETING_TTS_BRIDGE_ENV` to `"staging+prod"` on every production
deploy. That unconditional rule silently reintroduced the double-voice
pre-login greeting (VTID-04120's fix) on the very next, unrelated prod
deploy (VTID-04126), because VTID-04120's `env_overrides` suppression only
applied to that one dispatch.

## AC-1 — The unconditional pin no longer strips or re-adds the flag

The `jq` expression in the "Build task-definition (1/2 — image, commit
stamp, always-pinned flags)" step no longer references
`FEATURE_ORB_GREETING_TTS_BRIDGE_ENV` at all — neither in the strip
(`select(.name | IN(...))`) list nor in the re-add list. A future deploy
therefore leaves whatever value is currently on the live task definition
untouched, instead of forcibly resetting it every time.

TEST: services/gateway/test/orb/live/upstream/vtid-04100-prod-greeting-bridge-flag-pinned.test.ts

## AC-2 — The reversal is recorded with rationale, not left implicit

The workflow comment at the same location now explains why the always-pin
was removed (VTID-04100 → VTID-04120 → VTID-04126 → VTID-04127 → VTID-04128),
so a future reader does not have to reconstruct the incident from git blame.

TEST: services/gateway/test/orb/live/upstream/vtid-04100-prod-greeting-bridge-flag-pinned.test.ts

## AC-3 — The edited jq expression is syntactically valid and behaves correctly

`bash -n` passes on the edited step, the workflow file still parses as
valid YAML, and the edited jq expression was run against a synthetic ECS
task-definition JSON fixture carrying `FEATURE_ORB_GREETING_TTS_BRIDGE_ENV`
— confirmed it now passes through byte-for-byte instead of being
overwritten.

TEST: manual jq verification against a synthetic task-definition fixture — see commands.log and outputs/jq-verification.txt

## AC-4 — This reversal is scoped to one flag only

The other four flags this same block pins (`FEATURE_ORB_FAST_START_ENV`,
`FEATURE_ORB_BRAIN_CACHE_ENV`, `FEATURE_LATENCY_TELEMETRY_ENV`,
`FEATURE_ORB_SAFE_FAST_GREETING_ENV`) are untouched and remain
unconditionally pinned to `"staging+prod"`.

TEST: services/gateway/test/orb/live/upstream/vtid-04100-prod-greeting-bridge-flag-pinned.test.ts

## AC-5 — No collateral breakage to sibling workflow-shape suites

The sibling suites that also parse/validate `AWS-PROD-DEPLOY-GATEWAY.yml`
(input-count ceiling, `env_overrides` escape hatch, `env-only` deploy mode,
bash-syntax/size guard) still pass unmodified.

TEST: test/vtid-03958-env-overrides-input.test.ts, test/vtid-03961-env-only-deploy-mode.test.ts, test/scripts/workflow-dispatch-input-limit.test.ts, test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Scope note

This PR touches `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml`, which is
outside this validator's REMIT (`services/gateway/src|dist|openapi|test/`,
`docs/validation/`) — it has no gate of its own here (see
`scripts/ci/validator-path-guard.cjs`'s own header, VTID-03696). The one
in-remit file this PR changes
(`services/gateway/test/orb/live/upstream/vtid-04100-prod-greeting-bridge-flag-pinned.test.ts`)
is covered by the `gateway_backend` profile.

No route was added or removed (Route Mount Evidence Gate: N/A). No lockfile
changed (DEPENDENCY_CHANGE: N/A). No `oasis_events` topic, schema, or emit
call was added or changed (OASIS_IMPACT: no).
