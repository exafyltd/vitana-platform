# VTID-04276 — Acceptance

## Background

`GET /api/v1/routines`, `POST /api/v1/routines/:name/runs`,
`PATCH /api/v1/routines/:name/runs/:id`, and every route under
`/api/v1/routines/audits/*` require an `X-Routine-Token` header matching
`process.env.ROUTINE_INGEST_TOKEN` (`services/gateway/src/routes/routines.ts`,
`services/gateway/src/routes/routine-audits.ts`). Confirmed live: both
`gateway.vitanaland.com` and `preview-aws-gateway.vitanaland.com` answer
`503 {"error":"ROUTINE_INGEST_TOKEN env var not configured"}` on these
routes — the env var is unset on both live task definitions. This is the
root cause blocking every Claude Code Remote Routine that calls these
endpoints, independent of the separate dead-GCP-host problem those
routines also have.

This VTID wires the secret into both deploy workflows (inert until an
operator actually provisions the credential — this session has neither
`secretsmanager:CreateSecret` on AWS nor the ability to add a GitHub
Actions repository secret) and ships the provisioning script for staging.

AC-1 — Staging wires `ROUTINE_INGEST_TOKEN` optionally, describe-secret-gated

Same pattern as `OPERATOR_SQL_READONLY_DATABASE_URL` /
`OPERATOR_MACHINE_AUTH_TOKEN`: absent secret → deploy unaffected, routes
keep 503ing exactly as today; present secret → wired as a real AWS Secrets
Manager reference (`valueFrom`), never a plain value.

TEST: `services/gateway/test/vtid-04276-routine-ingest-token-wiring.test.ts`
("staging wires ROUTINE_INGEST_TOKEN optionally..." — 5 assertions: the
describe-secret call, the empty-string-not-exit-1 absent branch, the strip
before re-add, the conditional-only wiring, and that it is never
unconditional).

AC-2 — Prod wires `ROUTINE_INGEST_TOKEN` as a plain env var sourced from a GitHub Actions secret

The prod deploy role has no `secretsmanager:Describe*` (VTID-03880,
documented in `AWS-PROD-DEPLOY-GATEWAY.yml`'s own header comment for
`OPERATOR_SQL_READONLY_DATABASE_URL`), so the staging pattern cannot work
there. Mirrors the existing `MARKETPLACE_SYNC_SECRET` pattern instead — a
plain env var pinned unconditionally, sourced from
`${{ secrets.ROUTINE_INGEST_TOKEN }}` (a GitHub Actions repository
secret). Empty until the owner adds that repo secret, which resolves to
the identical "not configured" 503 the route already returns — never a
failed deploy.

TEST: same file, "prod wires ROUTINE_INGEST_TOKEN as a plain env var..."
— 3 assertions: sourced from the GH secret, pinned as a plain `value` (not
`valueFrom`), and no `describe-secret` call for it anywhere in the prod
workflow.

AC-3 — Both workflow files stay valid bash and under the GitHub Actions per-step size limit

VTID-03788's own regression guard (`bash -n` on every `run:` step across
both files, plus the 20,000-char cap that GitHub Actions actually enforces)
re-run clean after this change, including the two edited steps.

TEST: `services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts`
— re-run in full, 7/7 passing (both edited steps included).

AC-4 — The staging jq pipeline was exercised end to end against a mocked AWS CLI, not just parsed

Beyond `bash -n` (syntax only), the exact staging "Register task-definition
revision" script was run against a fake `aws`/`jq` toolchain seeded with a
minimal ECS task-definition JSON, once with the `routine-ingest-token`
secret present and once absent. Confirmed: present → the registered task
definition's `secrets` array contains exactly one
`{"name":"ROUTINE_INGEST_TOKEN","valueFrom":"<arn>"}` entry; absent → zero
such entries and the script still exits 0 (never blocks the deploy).

CURL: not applicable (no live route change — the routes already exist and
already behave exactly as documented above; this VTID changes only what
value they see in the environment). See `outputs/mock-aws-run.txt` for the
full transcript of both runs.

AC-5 — `scripts/aws/setup-routine-ingest-token-secret.sh` follows the established provisioning-script contract

Dry-run by default (`provision`/`status` actions), `--env staging|prod`,
`--apply` requires `ROUTINE_INGEST_TOKEN_VALUE` in the environment, never
overwrites an existing secret, tags the secret `vtid=VTID-04276`. Modelled
directly on `scripts/aws/setup-fish-audio-secret.sh`.

TEST: not unit-tested (a pure bash CLI wrapper around `aws
secretsmanager`, same as every sibling `setup-*-secret.sh` script in this
repo, none of which carry their own jest suite either) — verified by
direct reading against the template and a `bash -n` syntax check.

## Not done in this VTID (out of session reach)

- Actually creating either secret (`vitana/gateway/staging/routine-ingest-token`
  in AWS Secrets Manager, `ROUTINE_INGEST_TOKEN` as a GitHub Actions
  repository secret) — this session has neither
  `secretsmanager:CreateSecret` nor a tool to write repository secrets.
- Dispatching either deploy workflow — this wiring takes effect on the
  next ordinary staging auto-deploy / the next prod PUBLISH or manual
  dispatch, whichever the owner chooses, once the secrets exist.
- Rebuilding the 15 dead Claude Code Remote Routines to point at the
  corrected `gateway.vitanaland.com` host and send this token — tracked
  separately (this session's own follow-up, via `create_trigger`, not a
  code change in this repo).
