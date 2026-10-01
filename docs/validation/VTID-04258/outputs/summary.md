# VTID-04258 — Outputs

## Files changed

- `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` — `NAV_CONTINUATION_BIND`
  added to the strip list and re-add block, value `"true"`.
- `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` — new strip-then-add jq
  block declaring `NAV_CONTINUATION_BIND="true"`, declared not dispatched.
- `services/gateway/test/vtid-04258-nav-continuation-bind-flag-pinned.test.ts`
  — new regression test (5 assertions) pinning both workflow files.

## Expected CI signal

- `Validator Check`: green once `VALIDATION_PROFILE: gateway_backend` and
  the required PR-body markers are present (this evidence pack's own
  purpose).
- `Gateway CI`: the new test file should pass; no other gateway source was
  touched.
- Staging deploy (post-merge, automatic): `AWS-STAGE-DEPLOY-GATEWAY.yml`'s
  next run should upsert `NAV_CONTINUATION_BIND=true` on the live staging
  task definition — confirmable via `aws ecs describe-task-definition`
  against `vitana-gateway`, or by observing a real navigation confirmation
  on staging stop depending on Nova re-calling the tool.

## Not measured

No live AWS/gateway access from this session — the staging task
definition's env vars were not directly inspected before or after this
change; the "bare env var name with no confirmed value" finding comes from
`docs/AWS-PRODUCTION-HANDOVER.md`'s own recorded live inventory, not a
fresh `aws ecs describe-task-definition` call.
