# VTID-05023 agent H: staging PostgREST-Aurora proxy review (read-only)

Scope: service `vitana-postgrest-aurora-proxy`, cluster `Vitana-ECS-Cluster`, AWS account 472838866351, region eu-central-1.
Sources: repo `vitana-platform` at local `main` commit `ba5f26b4d8`, plus the GitLab API (project 2, reachable, HTTP 200).
Nothing was changed. No secret value was read or printed.

## Status

| Step | Result |
|---|---|
| 1. Read repo config and deploy workflow | Done. Intended config below. |
| 2. Health endpoint check | Not verified live. The internal URL does not resolve from this sandbox. |
| 3. AWS describe calls | Blocked by AccessDenied. Stopped here as instructed. |
| 4. Report | Below. Live state is unknown, so the findings describe intended config. |

## AWS access (blocked)

Run from this role: `arn:aws:sts::472838866351:assumed-role/kiro-1-dstevanovic/...`

1. `aws ecs describe-services --cluster Vitana-ECS-Cluster --services vitana-postgrest-aurora-proxy --region eu-central-1`
   Error, verbatim:
   `An error occurred (AccessDeniedException) when calling the DescribeServices operation: User: arn:aws:sts::472838866351:assumed-role/kiro-1-dstevanovic/d-9066619bb4.f4f8d4c8-f011-704f-fd15-3c8866b65dbd is not authorized to perform: ecs:DescribeServices on resource: arn:aws:ecs:eu-central-1:472838866351:service/Vitana-ECS-Cluster/vitana-postgrest-aurora-proxy because no identity-based policy allows the ecs:DescribeServices action`
2. `describe-task-definition` was not run. The service read is the step that gives the live task definition, and it was denied, so I stopped as instructed.
3. An extra name-only check, `aws secretsmanager describe-secret --secret-id vitana/supabase/staging/url-aurora-proxy`, was denied with `secretsmanager:DescribeSecret`. This means the staging URL secret cannot be confirmed to exist.

## Health endpoint (not reachable)

- Internal URL from the repo (`other-services.md`, the value written to `vitana/supabase/staging/url-aurora-proxy`): `http://postgrest-aurora.vitana.internal:8080`.
- `curl .../alive` returned exit 6, "Could not resolve host". The name is in the Cloud Map private namespace `vitana.internal`, which this sandbox cannot resolve.
- No public URL exists for staging. The staging service's `url` is `null` in `config/delivery/services.json`.
- The health path is `/alive` (proxy container). Its routing is covered by `services/postgrest-aurora-proxy/test/routing.sh`, which runs locally against a mock and does not touch AWS.

## What the proxy serves

Two `nginx` server blocks in one Fargate task (`services/postgrest-aurora-proxy/nginx.conf.template`), plus a `postgrest/postgrest:v12.2.3` sidecar on loopback port 3000.

- Internal default server, port 8080 (the one the gateway would use over Cloud Map):
  - `/rest/v1/<table>` and `/rest/v1/rpc/<fn>` go to PostgREST on Aurora, rewritten to `/<table>` and `/rpc/<fn>`.
  - `/auth/v1/`, `/storage/v1/`, `/functions/v1/`, `/realtime/v1/` pass through to the Supabase host named by `SUPABASE_AUTH_HOST`.
  - `/alive` returns `200 ok`. Any other path returns `501`.
- Public block, `server_name` from `PUBLIC_HOST`: only `/rest/v1` and `/alive`. Other paths return `404`.

Health path: `/alive`. This only proves nginx is up. It does not check PostgREST or Aurora.

## Intended configuration (names only)

Task family `vitana-postgrest-aurora-staging`, awsvpc, Fargate, 512 CPU and 1024 MB. Log group `/ecs/vitana-postgrest-aurora-staging`. Cloud Map name `postgrest-aurora` in the `vitana.internal` namespace.

`proxy` container:
- env: `SUPABASE_AUTH_HOST` (set in the task template, value not recorded here). `PUBLIC_HOST` is not set in the staging task, so the Dockerfile default applies.
- secrets: none.
- health check: `wget http://localhost:8080/alive`.

`postgrest` container:
- env: `PGRST_DB_SCHEMA`, `PGRST_DB_ANON_ROLE`, `PGRST_DB_USE_LEGACY_GUCS`, `PGRST_SERVER_PORT`, `PGRST_DB_PORT`, `PGRST_DB_HOST`, `PGRST_DB_NAME`.
- secrets: `PGRST_DB_URI` and `PGRST_JWT_SECRET`.
- health check: none, by design (README, 2026-09-20 status: the official image has no HTTP client).

Secret names the staging workflow injects:
- `PGRST_DB_URI` from `vitana/aurora/prod/postgrest-authenticator-uri`.
- `PGRST_JWT_SECRET` from `vitana/gateway/staging/supabase-jwt-secret`.

Deploy path: `.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`. It runs on push to `main` under `services/postgrest-aurora-proxy/**`. It takes the live service's current task definition, swaps the proxy image, rewrites the two secrets, registers a new revision, updates the service, and waits for stability. The prod counterpart is `AWS-PROD-DEPLOY-POSTGREST-AURORA-PROXY.yml`, which I did not run.

## Findings

1. **High: the "staging" proxy reads the production Aurora cluster.** The task template sets `PGRST_DB_HOST` to the `vitana-aurora-prod` cluster endpoint. The staging workflow hard-codes the prod authenticator secret name. `rehearsal.md` (revert step 11) says the staging proxy is currently on "the production authenticator secret". If the live task matches the repo, staging reads and writes prod Aurora data through a prod role. This must be confirmed against the live task definition, which I could not read.

2. **High: `PGRST_DB_HOST`, `PGRST_DB_PORT` and `PGRST_DB_NAME` are not PostgREST settings.** PostgREST takes its connection from `PGRST_DB_URI` alone (`db-uri`). I am working from PostgREST's config model; I did not check the v12.2.3 docs in this session. If that holds, changing the host means changing the URI secret, not those env vars. Any rehearsal that edits only those three env vars would still point at prod.

3. **High: the deploy and health check do not prove `/rest/v1` works.** The proxy health check is `/alive`, which nginx answers without contacting PostgREST. A wrong or unreachable `PGRST_DB_URI` leaves the task "healthy" and the service "stable". The workflow smoke step only checks that the image matches. So a bad database connection would pass the deploy. Recommended check: an authenticated `GET /rest/v1/<table>?limit=1` against the internal URL, run from inside the VPC, before any gateway is repointed. `setup-postgrest-aurora-proxy-staging.sh` already prints this command as a manual step.

4. **Medium: the staging task has no `PUBLIC_HOST`.** The Dockerfile default is `data.vitanaland.com`, which is the production public host. Nothing routes staging to this image today (`rehearsal.md` step 6 says `data-staging.vitanaland.com` "does not exist yet"). If that host is wired later, the staging task must set `PUBLIC_HOST` explicitly.

5. **Medium: any push to `services/postgrest-aurora-proxy/**` on `main` rebuilds staging from the live task definition.** A rehearsal overlay applied through the console or CLI is overwritten by the next push, which `rehearsal.md` already notes. The workflow also cannot target a rehearsal secret: it hard-codes the prod secret name, so the rehearsal needs a separate code path or a manual revision.

6. **Low: the `postgrest` container has no health check.** This is intended (see README). ECS treats the container as healthy once it is `RUNNING`, so the Aurora connection state is invisible to ECS. Finding 3 applies.

## Can it answer `/rest/v1` against the rehearsal clone?

Not yet. The clone and its wiring are missing. Needed, in order:

1. The clone exists and is `available`. Check with `AWS-REHEARSAL-AURORA-CLONE.yml` `action=status`, or `aws rds describe-db-clusters --db-cluster-identifier vitana-aurora-rehearsal`.
2. Secret `vitana/aurora/rehearsal/postgrest-authenticator-uri` exists, holding the clone's `authenticator` URI. `rehearsal.md` step 2 says no script creates it. Name only.
3. The `authenticator` role on the clone has its password, the `anon`, `authenticated` and `service_role` grants, and the `auth.*` shim functions. The clone copies production, so these should exist, but this is unverified.
4. The live task revision sets `PGRST_DB_URI` to the rehearsal secret, not the prod one. This needs a new task definition revision, which the workflow cannot produce as written (finding 5). Use the overlay in `scripts/aws/rehearsal-staging-overlay.json` (`staging_proxy`).
5. The app-tier security group can reach the clone on 5432. The clone's security group rules were not checked.
6. `PGRST_JWT_SECRET` matches the JWT signer. It is the staging JWT secret, which is correct for staging.

Once steps 1 to 6 hold, a `GET /rest/v1/profiles?limit=1` with the anon key should return rows, and an RLS-sensitive read should return only the caller's rows.

## Blockers and owner commands

Read access is needed to finish step 3 of the task. Owner options:

- Grant `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, and `secretsmanager:DescribeSecret` (names only) to `kiro-1-dstevanovic`. Then rerun:
  - `aws ecs describe-services --cluster Vitana-ECS-Cluster --services vitana-postgrest-aurora-proxy --region eu-central-1 --query 'services[0].{td:taskDefinition,running:runningCount,rollout:deployments[0].rolloutState}'`
  - `aws ecs describe-task-definition --task-definition <td from above> --region eu-central-1 --query 'taskDefinition.containerDefinitions[].{name:name,env:environment[].name,secrets:secrets[].name}'`
- Or run both commands with an admin role and send the output names to this lane.
- Confirm finding 1 on the live task: the `PGRST_DB_URI` `valueFrom` ARN should be the `vitana/aurora/prod/...` secret. Command: `aws ecs describe-task-definition ... --query 'taskDefinition.containerDefinitions[?name==`postgrest`].secrets[?name==`PGRST_DB_URI`].valueFrom'`. Print the ARN only.
- Owner decision, not for this agent: whether staging should keep reading prod Aurora at all. If not, the staging authenticator secret and a staging Aurora endpoint must be created before the next push to `main` touches the proxy.

## Not done

- No change to the proxy, its task definition or service, Aurora, secrets, the staging gateway, production, the GitHub workflows or the `vtid-05005` test.
- No start, stop or delete.
- The prod workflow was read, not run.