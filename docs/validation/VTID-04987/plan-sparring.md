# Plan sparring record — VTID-04987

Gate: Plan Sparring Gate (VTID-04868, CLAUDE.md rules 51–55). Partner: independent read-only plan-sparring-partner agent (Opus 4.6, session tier), saw only the plan file and the code.

Plan hash (sha256 of the text between the plan markers): a7e42d09e8d72a864ae19dd668f603d7f10673080e4c6c18680ebb19b5f7ea6e

- Class: standard. Rounds: 3 (cap). Round 1 — NOT CONVERGED (F1–F3 major: source-id union/tile, existing guard test, flag-gating mechanism; F4–F7 minor). Round 2 — NOT CONVERGED (F8 major: dimension classification needed two extra IAM grants; F9 minor). Round 3 — CONVERGED: F1–F9 and all questions closed.
- Verdict: CONVERGED. Owner approval: 2026-10-08 in the Claude Code session ("Yes, both plans approved").

---

# PLAN C — CloudWatch alarms in the Overview cockpit + ALB target-health alarm on the gateway

Change class: **standard** (IAM, deploy workflow env, new dependency, AWS resources).
Repo: exafyltd/vitana-platform. Owner decisions already given: Plan A owner decision 8 (2026-10-04) —
"ALB target-health alarm on vitana-gateway — approved, separate infra VTID"; Plan A REVISION 2 F8 — the
Overview reads CloudWatch alarm state via DescribeAlarms (read-only), the task-role IAM change is its own VTID.

<!-- plan:begin -->
## Goal
1. The supervisor cockpit (`GET /api/v1/ops/attention`, VTID-04876/04885) shows CloudWatch alarms that are
   in ALARM state. Today the `cloudwatch_alarms` source is listed as NOT_WIRED (the SDK is not a dependency;
   the gateway task role has no `cloudwatch:DescribeAlarms`; the adapter is gated by
   `OPS_ATTENTION_CLOUDWATCH_ENABLED`, default off).
2. An out-of-band alarm fires when the production gateway has no healthy ALB targets (plan A F1: the cockpit
   is the triage surface, GChat via SNS is the pager; a dead gateway cannot report itself).

## Scope (files)
- `services/gateway/package.json` + lockfile: add `@aws-sdk/client-cloudwatch` (same major as the existing
  `@aws-sdk/client-bedrock-runtime`), regenerated with npm, never by hand.
- `services/gateway/src/services/ops-attention-reads.ts`: `cloudwatchAlarms()` read — `DescribeAlarms` with
  `StateValue: 'ALARM'`, paginated, max 100, region from `AWS_REGION` (eu-central-1), 5 s SDK timeout; throws
  on error (→ source UNKNOWN), never "no alarms".
- `services/gateway/src/services/ops-attention-adapters.ts`: wire the existing gated adapter; rubric: an
  alarm whose name/namespace targets the gateway ALB or ECS service health = P1; other `ALARM` = P2;
  `INSUFFICIENT_DATA` not read. Deeplink: the existing Infrastructure/Services screen (verify in
  NAVIGATION_CONFIG). Remove it from `NOT_WIRED_SOURCES` only when wired.
- `scripts/aws/setup-gateway-cloudwatch-read-grant.sh` (new, dry-run by default, `--apply` to change):
  inline policy on the gateway ECS task role (resolved dynamically from the live task definition, never
  hardcoded) granting `cloudwatch:DescribeAlarms` only, Resource `*` (DescribeAlarms has no resource-level
  scoping). Verifies afterwards with a real read-only DescribeAlarms call.
- `scripts/aws/setup-gateway-alb-health-alarm.sh` (new, dry-run by default, `--apply`): resolves the prod
  gateway target group + ALB dynamically (`aws elbv2 describe-target-groups` by the ECS service's load
  balancer config), creates/updates alarm `vitana-gateway-prod-no-healthy-targets`:
  `AWS/ApplicationELB HealthyHostCount` Minimum < 1 over 2 × 60 s, TreatMissingData=breaching, actions → the
  existing ops SNS topic that forwards to GChat (resolved by name; script refuses if not found). Also a
  staging twin `vitana-gateway-staging-no-healthy-targets` behind `--env staging`.
- `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`: set `OPS_ATTENTION_CLOUDWATCH_ENABLED=true` on staging,
  in the same env strip/re-add block other flags use. Prod workflow: same flag, but only in a follow-up after
  staging shows the source `ok` (two-step, IF-THEN 31 ordering: grant first, verify, then flip).
- Tests: read (paginated, state filter, throws on error), adapter rubric + deeplink against
  NAVIGATION_CONFIG, flag gating (off → not_monitored, on + AccessDenied → UNKNOWN), workflow env present.
- Evidence pack `docs/validation/<VTID>/` incl. read-only staging-tests.json and the scripts' dry-run output.

## Order (and who)
1. PR merged with flag ON for staging only. Before merge the owner (or a principal with IAM rights) runs
   `setup-gateway-cloudwatch-read-grant.sh --apply` for the staging task role (this session's credentials
   are not assumed to have iam:PutRolePolicy; if they do, the session runs the dry-run, shows it, and asks).
2. Staging: STAGING-VERIFY confirms the source is `ok` (read-only, via the existing admin-signed staging
   probe pattern or the unauthenticated 401 + a CI test — never a write).
3. Alarm script `--apply` for prod + staging (owner or session after owner OK on the dry-run).
4. Prod: grant for the prod task role, then flag ON in the prod workflow (small follow-up PR, same VTID),
   promoted via PUBLISH with the usual ready message.

## Not in scope
SNS topic creation (must already exist), alarm tuning for other services, any write action from the cockpit.

## Risks
- Missing grant with flag ON → source UNKNOWN (honest), never green. Rollback: flag off.
- New dependency size: client-cloudwatch is small; lockfile regenerated by npm.
- Alarm noise during deploys: 2 × 60 s window with HealthyHostCount < 1 only fires when ALL targets are
  unhealthy, which rolling deploys do not do.
<!-- plan:end -->

---
# Planner responses — round 1 (the plan between the markers is amended by these)

F1 ACCEPTED — scope adds: (a) `'cloudwatch_alarms'` to the `AttentionSourceId` union, (b) to the `platform`
  tile's `sources` (alongside `service_health`), (c) removal from `NOT_WIRED_SOURCES`, which stays as an
  exported, now-empty array for future sources (Q2).
F2 ACCEPTED — the guard test `vtid-04885-ops-attention-phase2-adapters.test.ts:255-259` is replaced in the
  same PR by assertions that the dependency exists, the adapter is registered, the tile lists the source and
  `NOT_WIRED_SOURCES` is empty; the one-tile-per-adapter test is kept and passes with (b).
F3 ACCEPTED — gating = conditional registration, decided once in one helper `attentionAdapters()` that returns
  `ATTENTION_ADAPTERS` plus the CloudWatch spec only when `(process.env.OPS_ATTENTION_CLOUDWATCH_ENABLED ?? 'false') === 'true'`.
  The aggregator calls the helper instead of reading the constant. Flag off → the source is absent, and the
  tile computation reports a configured-but-unregistered source as `not_monitored` (never `ok`, never UNKNOWN);
  flag on + AccessDenied → `unknown` with the error. Tests cover both, plus the aggregator using the helper.
F4 ACCEPTED (clarified) — items deep-link to the existing `overview/system-overview` the platform tile uses;
  each item's evidence carries the alarm name, namespace, reason and state time. No new screen.
F5 ACCEPTED — the alarm script takes the ECS service name (`--service vitana-gateway-awsdr` for prod,
  `vitana-gateway` for staging), resolves cluster → service → loadBalancers[].targetGroupArn → ALB from AWS,
  never by target-group name, with a comment citing the documented naming trap (`vitana-tg-gateway-prod`
  serves STAGING). It prints what it resolved in dry-run.
F6 ACCEPTED (kept `breaching`, documented) — for a production gateway, "no data" and "no healthy targets"
  both mean "page someone"; an intentional drain is rare and the alarm text says so. The trade-off is
  written in the script header and acceptance.md.
F7 ACCEPTED — the prod-flag follow-up PR carries its own `staging-tests.json` whose checks re-run the same
  read-only staging probes (flag already on in staging since step 1); its PR body cites the green staging run
  of step 2. It reaches prod only through the usual ready message + PUBLISH.

Q1 — classification by dimensions, not names: `DescribeAlarms(StateValue=ALARM)` reads all alarms
  (paginated, cap 100 → partial_error when capped). P1 when the alarm's dimensions point at the production
  gateway: `TargetGroup`/`LoadBalancer` equal to the values resolved for ECS service `vitana-gateway-awsdr`
  (resolved once per 10 min via `elbv2`/`ecs` describe calls — needs `ecs:DescribeServices` and
  `elasticloadbalancing:DescribeTargetGroups` read grants, added to the same grant script), or
  `ServiceName=vitana-gateway-awsdr`. If the resolution itself fails, classification falls back to P2 for
  everything and the source reports a partial_error (never silently P2-only).
Q2 — `NOT_WIRED_SOURCES` stays exported and empty (see F1).
Q3 — the AWS read lives in a new `services/gateway/src/services/ops-attention-cloudwatch.ts` (SDK client,
  pagination, gateway-target resolution, cache), imported by `ops-attention-reads.ts` through the existing
  `AttentionReads` interface, so the adapter and its tests stay SDK-free.

# Planner responses — round 2 (supersede the Q1 answer above)

F8 ACCEPTED (took the partner's simpler alternative; Q1 above is withdrawn) — classification is by alarm
  name, not dimensions. P1 = an alarm in ALARM whose name starts with `vitana-gateway-prod-` (the
  production-gateway alarms; the alarm script creates `vitana-gateway-prod-no-healthy-targets` under that
  convention, and the convention is written into the script header and acceptance.md so future gateway
  alarms follow it). Every other alarm in ALARM = P2 (including `vitana-gateway-staging-*`). No ECS/ELB
  describe calls from the gateway, no resolution cache, no extra grants: the grant script adds
  **`cloudwatch:DescribeAlarms` only**, exactly as the scope already says. The ECS/ELB resolution stays only
  inside the operator-run alarm *script* (F5), which runs under the operator's own credentials, not the
  gateway task role.
F9 ACCEPTED — scope for `ops-attention-adapters.ts` adds `cloudwatchAlarms()` to the `AttentionReads`
  interface (and the test fakes in `test/fixtures/ops-attention-fakes.ts`); `ops-attention-reads.ts`
  implements it by delegating to `ops-attention-cloudwatch.ts`.
