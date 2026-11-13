# Acceptance — VTID-05702 (agentic-delivery-v2/delivery-bedrock)

Change types: Backend, Infrastructure/CI

## Backend (`services/gateway/src/providers/bedrock.ts`)
- **Outcome:** nothing changes for any current caller or user today. A future caller (the `spar-responder`/
  `review-service` lanes, both `depends_on: [delivery-bedrock]`, not built yet) will be able to pass
  `useDeliveryRole: true` to `invokeBedrock()` and have that one call served through the cross-account
  `vitana-delivery-bedrock` role in the `vitana-engineering` AWS account, instead of this gateway's own task
  role — so the delivery pipeline's plan-sparring/review traffic never shares, or depends on, production's
  Bedrock quota (plan agentic-delivery-v2 §10, §11, Phase 0 P3).
- **States:** not configured (`DELIVERY_BEDROCK_ROLE_ARN` unset) → `not_configured`, same shape as the existing
  `BEDROCK_ROLE_ARN` gate; region unresolved → `not_configured` with a region-specific message; the assumed
  role's credentials are cached and refreshed (re-assumed 60s before they would expire); an STS error (wrong
  account, denied trust, malformed response) surfaces as `invoke_failed` with the STS error code in the message,
  the same error shape every other Bedrock failure already uses.
- **Surfaces:** none — this is an internal provider function with no route or UI; every existing caller
  (`ai-bridge.ts`, `claude-text-client.ts`, `llm-router.ts`) is unaffected because none of them sets
  `useDeliveryRole` (confirmed by running every test that touches those call sites — see commands.log).
- **Locales / Accessibility:** n/a — no user-facing text or UI.
- **Contract:** `invokeBedrock(req: BedrockInvokeRequest)` gains one optional field, `useDeliveryRole?: boolean`.
  Omitted/false: byte-for-byte today's behaviour (same gate, same region resolution, same client construction,
  same error shapes). `true`: gated on `DELIVERY_BEDROCK_ROLE_ARN` (independent of `BEDROCK_ROLE_ARN`), resolves
  credentials via one `sts:AssumeRole` call (signed with this gateway's own task-role credentials, via
  `@aws-sdk/credential-provider-node`'s `defaultProvider()` — already a direct dependency), and passes the
  result explicitly to `BedrockRuntimeClient`'s `credentials` option.
- **Staging proof:** not independently observable yet — see `staging-tests.json`'s `not_verified_on_staging`
  field and the smoke/regression checks it does ship.

## Infrastructure/CI (`scripts/aws/setup-delivery-bedrock.sh`)
- **Plan:** the one file this script must reach is the IAM role `vitana-delivery-bedrock` in the
  `vitana-engineering` account; no task definition, deploy workflow or GitHub Actions file is touched by this
  lane (wiring `DELIVERY_BEDROCK_ROLE_ARN` into the staging gateway's task definition is a separate, later,
  owner/deploy-workflow step, named as such in the script's own "Next steps" output).
- **Build:** account guard (`provision` refuses account `472838866351`; `discover` refuses any other account)
  and region guard (both refuse any region but `eu-central-1`) run before any AWS call that isn't a read;
  `provision` is dry-run by default, `--apply` required to write; every write is also printed as the exact `aws`
  command it would run.
- **Staging proof:** n/a — this script deploys nothing and was not run against any real account (see the PR
  description and the lane log for why: this session has no credentials into `vitana-engineering`, and running
  it against `472838866351` would be the wrong account). Exercised instead: `bash -n` (syntax), `--help`, the
  no-AWS-call guard paths (wrong region for both subcommands, missing `--task-role-arn`) — see commands.log.
- **Reviewer:** the account/region guards actually run before any mutating call; the trust policy names only
  `--task-role-arn` as principal; the permissions policy is scoped to `bedrock:InvokeModel*` only, never
  broader.

## Test quality
- New file `services/gateway/test/delivery/bedrock-role.test.ts`: confirmed red on `origin/main` for the reason
  this change fixes (the new exports do not exist there — see `red-on-base.txt`), green after. No existing test
  was weakened; the full regression sweep of every real `invokeBedrock` consumer stayed green throughout.
