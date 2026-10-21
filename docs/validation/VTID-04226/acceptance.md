# VTID-04226 — EventBridge schedules for the test-contract scanners (`scheduled-run`, `missing`)

## Reported

Platform owner, 2026-09-21: `POST /api/v1/test-contracts/scheduled-run` and
`GET /api/v1/test-contracts/missing` (source_types
`test-contract-failure-scanner` / `missing-test-scanner`, both in
`autopilot-executable-source-types.ts`'s executor lane) lost their GCP cron
and were never added to `scripts/aws/setup-eventbridge-cron-migration.sh`.

## Verified first

- `scripts/setup-cloud-scheduler.sh` never contained either route (grep:
  zero hits), and the route header (`test-contracts-scheduled.ts`) says
  "Cloud Scheduler config (operator wires this manually post-merge)". No
  cadence exists in git to restore — the cadences below are chosen.
- Both routes authenticate a machine caller only via
  `X-Gateway-Internal: <GATEWAY_INTERNAL_TOKEN>` (`isInternalCaller()` in both
  files refuses when the env var is unset). Read off the live task defs:
  neither gateway carries `GATEWAY_INTERNAL_TOKEN`; no Secrets Manager entry
  exists for it (`aws secretsmanager list-secrets`). The VTID-03766 Lambda
  sends only `Content-Type` and can only POST.
- `GET /missing` is a pure read (lists gaps). It writes nothing; the
  row-producing path is the admin-only `POST /missing/:dedupe_key/allocate`.

## What changed

`scripts/aws/setup-eventbridge-cron-migration.sh` (VTID-03766 pattern, same
Lambda `vitana-cron-dispatch`):
- JOBS gains `gateway-test-contracts-scheduled-run` (`*/15 * * * *`, POST) and
  `gateway-test-contracts-missing` (`30 6 * * *`, GET). Both carry
  `auth: "gateway_internal"` and `gateway_url: $TEST_CONTRACTS_GATEWAY_URL`
  (default `https://preview-aws-gateway.vitanaland.com`; prod is an explicit
  override, IF-THEN 26). 25 existing jobs untouched (27 total).
- Lambda: optional Input fields `method`, `headers`, `gateway_url`, and
  `auth: "gateway_internal"` → reads the token from Secrets Manager
  (`GATEWAY_INTERNAL_TOKEN_SECRET_ID`, cached per container). The token is
  never in the schedule Input nor a plain env var. Non-2xx still rejects
  (a 403 from a missing token is a visible Lambda failure).
- Lambda exec role gets `secretsmanager:GetSecretValue` on that one secret.

`scripts/aws/setup-gateway-internal-token.sh` (new, dry-run by default):
creates/rotates `vitana/gateway/<env>/internal-token` (64-hex). Staging
default; prod only with `--env prod`. `AWS-STAGE-DEPLOY-GATEWAY.yml` (VTID-04225)
wires the secret onto the staging task def when it exists.

## `--dry-run` then `--apply`: apply is BLOCKED by IAM in this session

`outputs/dry-run.txt` shows the 27 jobs. `--apply` was NOT run: the session
principal `arn:aws:iam::472838866351:user/claude-code-aws-agent` is denied
`iam:GetRole`, `lambda:GetFunction`, `scheduler:GetSchedule` and
`scheduler:ListSchedules` (`outputs/iam-probe-apply-blocked.txt`) — the exact
prerequisites VTID-03766's own header lists as "NOT covered by this
session's AWS grant". `aws scheduler get-schedule` confirmation is therefore
also impossible from here. Owner steps, in order:

1. `scripts/aws/setup-gateway-internal-token.sh --apply` (creates the secret).
2. Redeploy staging (push to `main` does it) → `GATEWAY_INTERNAL_TOKEN` lands.
3. `DEFAULT_TENANT_ID=<tenant> scripts/aws/setup-eventbridge-cron-migration.sh`
   (updates the Lambda code/env/role and upserts all 27 schedules).
4. `aws scheduler get-schedule --name gateway-test-contracts-scheduled-run`
   and `aws logs tail /aws/lambda/vitana-cron-dispatch --since 30m`
   (expect `/api/v1/test-contracts/scheduled-run responded 200`).

## Should `/dev-autopilot/scan` also move to EventBridge? No — it stays in Actions.

The scan is not a "POST a fixed body" job: `scripts/ci/dev-autopilot-scan.mjs`
walks the checked-out repo (2,583 files, 6 roots), runs `npm install` per
service for `npm-audit-scanner-v1`, builds `signals.json` (~120 KB, 2,327
signals on run #324) and only then POSTs it. That needs a checkout, Node and
the npm cache — a GitHub runner, not a 180-second HTTPS-only Lambda. The
gateway-side work (`/scan` ingest + ranking) is already synchronous inside
the request. Keep the cron in `DEV-AUTOPILOT.yml` (now pointed at staging,
VTID-04225); EventBridge is the right home only for routes whose whole job
runs inside the gateway (`scheduled-run`, `missing`, the AP-XXXX crons).

## Gap, reported not built

A scheduled `GET /missing` produces no `autopilot_recommendations` row — it is
a listing. The missing-test scanner only writes through the admin-only
allocate endpoint. If the loop is meant to pick up test gaps unattended, it
needs an internal-token-authed sweep (allocate top-N gaps per tick) — a
separate VTID and an explicit owner decision, since it mints VTIDs.

## Acceptance criteria

AC-1 The JOBS list carries both routes with the chosen cadences, the internal-token auth marker and the staging gateway target; the 25 VTID-03766 jobs are unchanged.
TEST: services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts — "EventBridge JOBS carry the two test-contract scanners"

AC-2 The Lambda supports method/gateway_url/auth=gateway_internal, reads the token from Secrets Manager only, and still fails loudly on non-2xx.
TEST: services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts — "the shared Lambda can present X-Gateway-Internal"

AC-3 Both scripts parse (`bash -n`), `--dry-run` prints the two new jobs without calling AWS, and the token script is dry-run by default.
TEST: services/gateway/test/vtid-04226-eventbridge-test-contract-schedules.test.ts — "scripts parse and dry-run"

AC-4 The staging gateway task def picks the token up automatically once the secret exists (optional wiring, never fails a deploy).
TEST: services/gateway/test/vtid-04225-no-dead-gcp-urls-in-workflows.test.ts — "wires GATEWAY_INTERNAL_TOKEN only when its secret exists"
