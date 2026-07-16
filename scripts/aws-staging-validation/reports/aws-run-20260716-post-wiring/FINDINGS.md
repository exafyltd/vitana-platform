# AWS staging validation — post-wiring run, 2026-07-16

Follow-up to `../aws-run-20260716/` (which found the environment unreachable:
ALB 503, empty target groups). Write access was granted
(`AmazonECS_FullAccess` + `ElasticLoadBalancingFullAccess` on
`claude-staging-validation`) and the wiring was fixed live, then the parity
suite re-ran.

## Remediation applied (via AWS API, this run)

1. **Gateway target-group health check** changed from `/health` → `/alive`
   (platform canon; the gateway serves both, but `/alive` is the rule).
   `vitana-tg-community-prod` keeps `/` — the frontend nginx has **no**
   `/alive` (only `/healthz`, which canon forbids, and `/`, which serves the
   SPA index at 200); changing that needs an nginx.conf + image change in
   `exafyltd/vitana-v1`.
2. **`vitana-gateway` ECS service** attached to `vitana-tg-gateway-prod`
   (container `gateway`, port 8080, 60s health-check grace).
3. **`vitana-community-app` ECS service** attached to
   `vitana-tg-community-prod` (container `community-app`, port 8080 — the
   container listens on 8080; the TG's default port 80 is irrelevant for
   `ip` targets since ECS registers the container port).

Both services rolled new tasks; targets registered and went **healthy**
within ~90 seconds. No security-group changes were needed
(`vitana-sg-ecs-app` already allowed 8080 from the ALB SG).

## New verdict

**RESULT: FAIL — but no longer unreachable.** 9 FAILs → **4 FAILs / 2 WARNs**
(see `parity-report.md`). Reachability, Supabase alignment (gateway-side),
security headers, WebSocket upgrade behavior, latency, frontend
reachability and SPA fallback all now PASS.

**Update (same day, 16:18Z):** gap #1 below was subsequently fixed live
(task definition `vitana-gateway:5`), so the effective count is
**3 FAILs / 2 WARNs** — the parity-report.md in this directory predates
that fix and still shows the env-identity row as FAIL.

## Remaining gaps

| # | Check | Cause | Fix |
|---|-------|-------|-----|
| 1 | ~~env identity (`env='production'`)~~ **RESOLVED 2026-07-16 16:18Z** | Task def set `ENV=staging`, but the gateway reads **`VITANA_ENV`** (`services/gateway/src/env.ts`, used by `admin-health.ts`) | **Applied:** registered task definition `vitana-gateway:5` with `VITANA_ENV=staging` added (kept `ENV=staging`), rolled the service to steady state, verified `/api/v1/admin/health` → `env=staging` through the ALB. Mirror into Terraform/task-def source, same drift warning as below. |
| 2 | Route mounts: `/api/v1/discover`, `/api/v1/intents`, `/api/v1/intent-board`, `/api/v1/intent-categories` missing | AWS runs a **stale gateway image** — those routers shipped recently (e.g. Discover/VTID-02950 merged 2026-07-16); build-info also stamps no `git_commit` | Rebuild/redeploy the AWS gateway image from current `main`, and stamp `GIT_COMMIT_SHA` in the AWS build pipeline (WARN #1) |
| 3 | CORS preflight unanswered | The gateway's allowed-origins list doesn't include the ALB origin used as `Origin:` in the probe. Partly an artifact of having no real DNS name — but the eventual AWS staging frontend origin must be allowlisted | Create the AWS staging DNS names, then add the frontend origin to the gateway CORS config |
| 4 | Frontend→gateway wiring | The AWS frontend bundle bakes `https://gateway.vitanaland.com` — which currently resolves to a **Google** IP, i.e. the AWS frontend silently calls the GCP gateway | Rebuild the frontend with `VITE_GATEWAY_URL` pointing at the AWS staging gateway hostname once DNS exists |

Also still open from the first run: no `vitanaland.com` DNS record points at
the ALB (this run again used the raw ALB DNS name with TLS verification
disabled — the ACM wildcard `*.vitanaland.com` is already issued, only the
records are missing), and the frontend is served under the `/community` path
prefix on the ALB while GCP staging serves it at the domain root (SPA
fallback happens to work because nginx rewrites unknown paths itself, but
the base-path decision should be made deliberately before cutover).

## Update 2026-07-16 ~17:05Z — gaps #2 (stale image) and #3 (CORS) fixed in a new image, blocked on ECR push

A replacement gateway image was built in-session and **verified locally**,
but cannot be pushed: `claude-staging-validation` has ECR auth/pull but not
`ecr:InitiateLayerUpload`/`PutImage` (AmazonECS_FullAccess does not include
ECR pushes). Grant push on `repository/vitana/gateway` (e.g.
`AmazonEC2ContainerRegistryPowerUser`) and the fix ships in minutes.

What the new image contains (tagged `vitana/gateway:e7a2e42` locally,
built from branch commit `e7a2e42` = current `main` + the CORS fix):

- **Current `main` code** — the missing `/api/v1/discover` + intents routers
  are present: local boot answers `application/json` on
  `/api/v1/discover/feed` (500 only because the bare test container has no
  Supabase secrets; ECS injects them).
- **CORS fix** (`services/gateway/src/middleware/cors.ts`, committed on this
  branch): the AWS ALB origin added to `ALLOWED_ORIGINS` — local preflight
  with that Origin returns 204 + `Access-Control-Allow-Origin`. The list is
  hardcoded, so this HAD to be a code change + rebuild; the commit should be
  merged to `main` so future images keep it.
- Build method (sandbox constraints, documented for reproducibility): Docker
  Hub and registry.npmjs.org are blocked from this environment, so the image
  was assembled `FROM` the existing ECR image (prod `dependencies` in
  `package.json` are identical between it and `main`), with `dist/` freshly
  compiled from branch source via `tsc --noCheck` (TypeScript 6.0.2 from npm
  cache; emit-only — full typechecking was impossible without the pinned
  5.9.3 + `@types/*`, which the registry block prevented; CI typechecks the
  same code on merge) plus the `copy-frontend`/`copy-data` assets and a
  regenerated `BUILD_INFO`.

After the push lands, remaining steps for gap #2/#3: `aws ecs update-service
--force-new-deployment` (or a task-def revision adding
`GIT_COMMIT_SHA=<sha>` to also clear the build-info WARN — git_commit is
read from that env var at runtime), then re-run the parity suite. Expected
remaining FAIL: only #4 (frontend bundle gateway URL), which needs a
`vitana-v1` rebuild and the DNS decision.

## Note on the ECS attachment method

The attachments were made with `aws ecs update-service --load-balancers ...`
directly. If this environment is Terraform-managed (the
`vitana-tfstate-eu-central-1` bucket suggests it is), the same wiring must be
added to the `aws_ecs_service` resources (`load_balancer` block +
`health_check_grace_period_seconds`) and the gateway TG's
`health_check.path = "/alive"` — otherwise the next `terraform apply` will
silently detach the services again.
