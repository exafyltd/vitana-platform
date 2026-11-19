# Record: AWS staging scale-down of 2026-11-17 (CloudTrail, eu-central-1, account 472838866351)

Status of the reason: **UNCONFIRMED.** No change record, VTID, PR or ticket naming this action was found.
It stays unconfirmed until Dragan Stevanović confirms it or a change record is found.

## The scale-down
Two explicit `ecs:UpdateService` API calls from Dragan's session, one second apart:

| eventTime (UTC) | Principal | Source / user agent | Service | Request |
|---|---|---|---|---|
| 2026-11-17T09:34:51Z | `arn:aws:iam::472838866351:user/d.stevanovic@vitanaland.com` | 3.120.208.65, `aws-cli/2.40.1` | `vitana-gateway` | `desiredCount: 0` |
| 2026-11-17T09:34:52Z | same | same | `vitana-postgrest-aurora-proxy` | `desiredCount: 0` |

Not an automatic action: no Application Auto Scaling activity, no ECS deployment circuit breaker, and no CI role in
the same window. Both calls succeeded (no `errorCode`).

## Related events the same day (context, not the scale-down)
- 16:32 `claude-code-aws-agent` attempted CreateTargetGroup / CreateRule / CreateService for the preview: AccessDenied.
- 16:49–16:50 Dragan's identity via `aws-mcp.amazonaws.com` created target group `vitana-tg-gateway-preview`,
  listener rule priority 31 (host `preview-aws-gateway.vitanaland.com`) and service `vitana-gateway-preview`
  (desired 0, tag `ManagedBy=ChatGPT-AWS-Core`, task definition `vitana-gateway-preview:1` registered 16:22 by
  `claude-code-aws-agent`).
- 20:51 proxy back to desired 1 and preview to desired 1; 20:59:34 preview back to desired 0 (same identity via aws-mcp).
- 21:33 `claude-code-aws-agent` registered `vitana-postgrest-aurora-staging:20`; 22:18 Dragan's identity rolled the proxy to it.
- 23:05 / 23:08 `vitana-gitlab-deploy-role` rolled `vitana-gateway` to :1024 then back to :1016 (desired stayed 0).

## Observed state at the time of the record (2026-11-18 ~09:30 UTC)
`vitana-gateway` 0/0 on :1016, `vitana-gateway-preview` 0/0 on :1, `vitana-postgrest-aurora-proxy` 1/1 on
`vitana-postgrest-aurora-staging:20`. PLAN-SPAR run 44175611802 failed with `create retry: HTTP 504`.

## What is known about a possible reason (not a confirmation)
`vitana-gateway:1016`, the service behind the "staging" hostname, carries `ENV=prod`, `DB_HOST=vitana-rds-proxy-prod…`
and `REDIS_HOST=…vitana-redis-prod…`. Draft PR #5110 describes it as "production-attached". That is consistent with a
deliberate shutdown, but neither the CloudTrail entries nor any file in git state the reason.
