# VTID-04262 — wire OPERATOR_MACHINE_AUTH_TOKEN into the staging deploy workflow

## Report

VTID-04133 built the Operator Console machine-to-machine auth mechanism and
its provisioning script, but deliberately left the secret out of
`AWS-STAGE-DEPLOY-GATEWAY.yml`'s wiring in the same PR — that workflow's
secret-resolution loop hard-fails the whole staging deploy if a REQUIRED
secret is missing, and the building session had no AWS credentials to
confirm the secret existed first.

The secret now exists: `vitana/gateway/staging/operator-machine-auth-token`
was provisioned live by the platform owner (their own AWS admin session,
since this session's IAM identity — `claude-code-aws-agent` — has an
explicit deny on `secretsmanager:CreateSecret` via its permissions boundary,
confirmed with a real `AccessDeniedException`, the same wall recorded for
every other provider secret in this file's CHANGE LOG).

This VTID wires it into the deploy workflow the same OPTIONAL,
`describe-secret`-gated way `OPERATOR_SQL_READONLY_DATABASE_URL` already is
— never a required entry in the hard-fail loop. Absent, the deploy proceeds
unaffected; present, it activates `OPERATOR_MACHINE_AUTH_ENABLED=true` and
wires the token as an ECS `secrets` reference (never a plain env value, so
it is never visible in `describe-task-definition` output or CloudWatch).

## Acceptance Criteria

AC-1 — The staging deploy workflow probes for the secret via
`aws secretsmanager describe-secret` before referencing it, exactly like
the SQL-readonly and ERP-bridge secrets, and never hard-fails the deploy
when it is absent.
TEST: services/gateway/test/vtid-04262-staging-operator-machine-auth-wiring.test.ts

AC-2 — `OPERATOR_MACHINE_AUTH_ENABLED`/`OPERATOR_MACHINE_AUTH_TOKEN` are
stripped from the inherited task definition before being conditionally
re-added, so a stale value from a prior manual edit cannot silently
survive a deploy.
TEST: services/gateway/test/vtid-04262-staging-operator-machine-auth-wiring.test.ts

AC-3 — `OPERATOR_MACHINE_AUTH_ENABLED=true` is written to the task
definition ONLY inside the `if $SEC_MACHINE_AUTH != ""` guard — never as an
unconditional flag the way e.g. `ORB_CASCADED_VOICE_ENABLED` is — and the
token is wired via `secrets` (`valueFrom`), never `environment` (`value`).
TEST: services/gateway/test/vtid-04262-staging-operator-machine-auth-wiring.test.ts

AC-4 — The `AWS-STAGE-DEPLOY-GATEWAY.yml` `run:` step this change is
inside of remains valid bash after the edit (VTID-03788's standing
regression guard).
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-5 — This staging-only credential is NOT declared on
`AWS-PROD-DEPLOY-GATEWAY.yml` — the provisioning script's own header states
there is no product reason to ever provision it for prod.
TEST: services/gateway/test/vtid-04262-staging-operator-machine-auth-wiring.test.ts

## Route evidence

No route is added, removed, or mounted by this change — it is a CI/CD
workflow (`.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`, outside this
gate's REMIT and therefore not path-judged under the `gateway_backend`
profile) plus one new test file under `services/gateway/test/`. The
Route Mount Evidence Gate does not apply.

## Not yet independently confirmed against live traffic

The next staging deploy after this merges is the first real exercise: the
`describe-secret` probe should log
`resolved vitana/gateway/staging/operator-machine-auth-token -> OPERATOR_MACHINE_AUTH_ENABLED=true`,
and a subsequent request to `POST /api/v1/operator/chat` carrying
`X-Operator-Machine-Token: <token>` should pass VTID-03851's
`isExecuteTaskAuthorized()` gate for the first time. That live check — and
using it to queue the Command Hub Autopilot supervisor-visibility task list
into the Operator Console — is the direct next step after this deploys.
