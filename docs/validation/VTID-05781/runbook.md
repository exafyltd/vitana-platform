# VTID-05781 — staging data-plane switch: owner runbook, rollback and recovery

Plan `autonomous-to-staging-r2` §3.4 (stage 3), decision record `design.md` §6, §8, §9. Owner directive 2026-11-12:
*"approval to revise and validate the plan, not approval to incur infrastructure costs or execute the database
provisioning and cutover"* and *"Do not switch staging away from its current authentication or database configuration
until a safe, reversible transition is demonstrated."* Nothing in this lane flips staging. Every step below is an owner
action or an owner-approved dispatch.

## 1. The switch
Repository variable `STAGING_DATA_PLANE` on `exafyltd/vitana-platform`:

| Value | Effect on `AWS-STAGE-DEPLOY-GATEWAY.yml` / `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml` |
|---|---|
| unset, empty or `shared` (default) | The roll step runs exactly as before this lane (byte-identical task definition, test `cutover-workflows.test.mjs`). If the live task definition carries the isolated marker (after a flip), it is restored to the shared plane. |
| `isolated` | Refused unless `STAGING_CUTOVER_APPROVED=yes`. Data-plane references move to `vitana/aurora/staging-db/*`; gateway `VTID_ALLOCATOR_ENABLED=false`; authentication unchanged. Gateway needs `data_backend=keep`. |
| anything else | The deploy fails before registering anything (fail closed). |

What moves (isolated) and what does not:

| Entry | Shared (today) | Isolated |
|---|---|---|
| gateway `AURORA_DATABASE_URL` | production Aurora admin URL secret | `vitana/aurora/staging-db/database-url` (role `vitana_staging_app`) |
| gateway `AURORA_RLS_DATABASE_URL` | production authenticator URI | `vitana/aurora/staging-db/postgrest-authenticator-uri` |
| gateway `SUPABASE_URL` | the staging PostgREST proxy URL secret (required: `data_backend=aurora` first) | unchanged secret; the proxy behind it now reads the staging database |
| gateway `OPERATOR_SQL_READONLY_DATABASE_URL` (and `DATABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_DATABASE_URL` if present) | direct database URLs | removed; `OPERATOR_SQL_READONLY_BACKEND=supabase` |
| gateway `VTID_ALLOCATOR_ENABLED` | absent | `false` |
| PostgREST `PGRST_DB_URI` | production authenticator URI | staging authenticator URI |
| PostgREST `PGRST_DB_HOST` | production writer host | removed (the URI carries the host) |
| `SUPABASE_JWT_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE(_KEY)`, `GATEWAY_SERVICE_TOKEN`, `SUPABASE_PUBLIC_URL`, `SUPABASE_AUTH_HOST`, `PGRST_JWT_SECRET` | production Supabase GoTrue issuer | **unchanged** (design.md §3) |

Any other entry that still names a production identifier (staging-prod-ref-guard list) refuses the switch.

## 2. Owner actions, in order
1. Stage 2 first (docs/STAGING.md §3.3): `STAGING_DB_COST_APPROVED=yes`, apply `infra/staging-db/stack.yaml` (no candidates),
   set `AWS_STAGING_DB_ROLE_ARN`, run `AWS-STAGE-PROVISION-DB.yml` `apply` then `load`.
2. IAM on the existing staging deploy role (owner-applied, design.md §4; this lane does not edit IAM):
   `secretsmanager:DescribeSecret` on `…:secret:vitana/aurora/staging-db/*`; `ecs:UpdateService` on
   `…:service/Vitana-ECS-Cluster/vitana-gateway-iso` and `…/vitana-postgrest-aurora-staging-iso`. The task execution role
   of both staging services needs `secretsmanager:GetSecretValue` on `vitana/aurora/staging-db/*` and `kms:Decrypt` on
   the stack key `alias/vitana-staging-db` (ViaService secretsmanager), or the isolated tasks cannot start.
3. Set repository variable `AWS_STAGING_ROLE_ARN` if it is not set: the two new workflows use OIDC only, never the static
   staging keys.
4. `AWS-STAGE-CUTOVER-REHEARSAL.yml` `mode=secrets` (fills the two placeholder secrets; roles `vitana_staging_app`,
   `authenticator`).
5. `AWS-STAGE-CUTOVER-REHEARSAL.yml` `mode=register`; pass the two printed ARNs to a second stack apply with
   `CandidateGatewayTaskDefinitionArn`, `CandidatePostgrestTaskDefinitionArn`, `CandidateAppSecurityGroupId`,
   `CandidateAlbListenerArn` (creates `vitana-gateway-iso`, `vitana-postgrest-aurora-staging-iso` at desired count 0 and
   the host rule `preview-iso-gateway.vitanaland.com`); add the DNS record for that host.
6. Create secret `vitana/supabase/staging/url-aurora-proxy-iso` with the URL the candidate gateway reaches the candidate
   PostgREST on (the stack gives the candidate PostgREST service no service-discovery name today; see "Unresolved").
7. `AWS-STAGE-CUTOVER-REHEARSAL.yml` `mode=run` on `main`. Evidence in the run summary and artifact `rehearsal-evidence`.
8. Governance endpoint: `PLAN_SPAR_GATEWAY_URL=https://gateway.vitanaland.com` (PLAN-SPAR and VTID-ALLOCATE default to
   the staging gateway, PLAN-SPAR.yml:92, VTID-ALLOCATE.yml:36).
9. Impact: run `node scripts/ci/staging-db/impact.mjs`; for each `governance-signal-write` workflow either change its
   target first or accept the effect by listing it in `STAGING_CUTOVER_IMPACT_ACCEPTED` (comma list).
10. `STAGING_DB_CLIENT_SG_ID` = stack output `DbClientSecurityGroupId`; `STAGING_CUTOVER_APPROVED=yes`.
11. `AWS-STAGE-CUTOVER.yml` `action=flip`, `commit_sha` = the rehearsed commit, when no staging deploy or STAGING-VERIFY
    is queued or running (the gate refuses otherwise).
12. After a green flip: `STAGING_DATA_PLANE=isolated` (until then the next staging deploy restores the shared plane).

## 3. Rollback and recovery criteria (design.md §8)
- **Rehearsal** changes nothing that serves: only the `-iso` services, scaled back to 0 in an `always()` step.
- **Flip:** the job records both services' PRIMARY task-definition ARN and network configuration (artifact
  `cutover-record`) before any change. Any failure after the record (registration, rollout, revision check, smoke)
  runs the automatic rollback in the same job: both services back to the recorded revision and network configuration.
- **Recovered** means: both PRIMARY deployments on the recorded ARNs with `rolloutState=COMPLETED` and running = desired
  (`staging-cutover-ecs.sh verify`), and the STAGING-VERIFY gateway smoke (`smoke/gateway.json`: `/alive`, admin health
  `env=staging`, build-info `env=staging`, ORB/Nova/autopilot/VTID/scheduler/operator health, OASIS tasks, two auth
  refusals) passes in full. Each service waits at most 15 minutes; the job has 75 minutes.
- **Not recovered** (rollback or its smoke failed): job `recover` re-dispatches both staging deploys; the variable is
  still `shared`, so they rebuild today's task definitions. The owner checks their STAGING-VERIFY.
- **Manual rollback, any time:** `AWS-STAGE-CUTOVER.yml` `action=rollback`, `record_run_id` = the flip run; or set
  `STAGING_DATA_PLANE=shared` and dispatch both staging deploys (the isolated marker is restored entry by entry).
- **Data:** rows written to the isolated database stay there; it holds synthetic data only and is never merged back.
- **Client SG:** the flip adds `vitana-aurora-staging-client-sg` to both services; a rollback restores the recorded
  network configuration (removes it). A shared redeploy does not change network configuration; the SG only grants
  reach to the staging database.

## 4. Impact on active staging sessions and STAGING-VERIFY
- **Rehearsal:** none on the serving services. The candidates run with the background loops off (autopilot heartbeat,
  Dev Autopilot watcher, reminders, calendar sync/maintenance, feedback dispatch, PM agent) and without the GitHub merge
  token, so a second gateway never acts on GitHub or members.
- **Flip window (~10–20 min):** ECS replaces the tasks of both services (rolling). Open ORB/WebSocket sessions on staging
  drop and reconnect; signed-in staging sessions stay valid (same issuer, same JWT secret) but now read the synthetic
  database, so a real member signed in on staging sees an empty Vitana. The gate refuses while a staging deploy or
  STAGING-VERIFY is queued or running; merges that land during the window queue their deploy behind it.
- **After the flip:** change suites that read data rows fail without a seed row. `impact.mjs` classifies all 446 suites
  today: 364 plane-neutral, 36 schema-dependent (health routes; the schema bundle proves the tables), 46 need review;
  the flip is refused while an in-flight lane (executing, in-review, verified) has a needs-review suite (8 today).
- **Governance:** PLAN-SPAR/VTID-ALLOCATE must point at production first (flip refused otherwise). Signal writers
  (Dev Autopilot scan and impact ingest, E2E self-heal reports, screen-load timing, request notifications, the staging
  Kiro runner's MCP) would land in the synthetic database: the flip is refused until each is redirected or accepted.
  STAGING-VERIFY result records keep going to production OASIS (unchanged).
- **Not isolated by this switch:** `/auth/v1`, `/storage/v1`, `/functions/v1` and `/realtime` pass through the PostgREST
  proxy to the production Supabase project, as today. Isolation covers the REST data plane and the direct Aurora URLs.

## 5. Shared AWS resources (design check)
Staging and production share `Vitana-ECS-Cluster`, the task role `vitana-ecs-task-role`, the execution role
`vitana-ecs-task-execution-role` and the app security group `sg-0fbcf7b59b1f0d685`
(`scripts/aws/setup-postgrest-aurora-proxy-staging.sh:90,102-104`). This lane changes none of them: isolated revisions copy
the roles of the live staging revision, every ECS write is limited by name to the two live staging services (flip,
rollback) or the two `-iso` candidates (rehearsal), production-looking names (`*awsdr*`, `*prod*`) are refused even if
put on a list, and the cluster must be `Vitana-ECS-Cluster`.
