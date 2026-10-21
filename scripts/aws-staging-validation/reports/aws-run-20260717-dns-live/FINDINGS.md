# AWS staging validation — DNS-live run, 2026-07-17

Third parity run, after `preview-aws.vitanaland.com` and
`preview-aws-gateway.vitanaland.com` DNS records went live against
`vitana-alb-prod` (TLS verifies via the existing `*.vitanaland.com` ACM
cert — no more raw-ALB `-k` workaround; this run used plain curl).

## Infra change applied this run

- **Host-based listener rule** added to the ALB HTTPS listener at
  **priority 30** (below the `/api/*`+`/ws/*` and `/community*` path rules,
  above default): `Host = preview-aws.vitanaland.com` → forward to
  `vitana-tg-community-prod`. The frontend now serves the SPA at the domain
  ROOT (matching GCP staging's shape), while `/api/*` on any host still
  reaches the gateway and the gateway hostname falls through to the default
  rule. Verified: `/` serves the SPA (`<title>VITANA Platform</title>`),
  `/settings` deep-route returns 200 (nginx SPA fallback), assets serve,
  and the gateway host still 302s `/` → `/command-hub/`.
  **Mirror into IaC** (same drift warning as the earlier ECS/TG changes).

## Verdict: FAIL — 3 FAILs / 2 WARNs (was 9/4 at first run)

Everything infrastructure-level now PASSES: both stacks reachable,
`env=staging` on both, Supabase host aligned (gateway and frontend),
security headers, WebSocket upgrade parity, latency within threshold,
frontend reachable + SPA fallback at the root of its own hostname.

Remaining FAILs, all with fixes already staged or specified:

| # | Check | Status of the fix |
|---|-------|-------------------|
| 1 | Route mounts (`/api/v1/discover`, `/api/v1/intents`, `/api/v1/intent-board`, `/api/v1/intent-categories` missing) | Fixed image **built + locally verified**, tagged `vitana/gateway:12b0542` in the session Docker daemon — **blocked on ECR push perms** (`ecr:InitiateLayerUpload` etc. on `repository/vitana/gateway`; still denied as of this run) |
| 2 | CORS preflight unanswered | Same staged image: `cors.ts` now allowlists `preview-aws.vitanaland.com` + `preview-aws-gateway.vitanaland.com` (commit `12b0542`, replacing the interim raw-ALB entry). Ships with fix #1 |
| 3 | Frontend bundle bakes `gateway.vitanaland.com` (GCP) | **Not fixable from this sandbox**: `vitana-v1` has no `node_modules`, the npm registry is blocked, and the community-app runtime image contains only compiled static files (no Vite toolchain to reuse). Rebuild via the normal frontend pipeline with `VITE_GATEWAY_URL="https://preview-aws-gateway.vitanaland.com/api/v1"` (note the `/api/v1` suffix, matching the current `.env` shape), push to `vitana/community-app`, force new deployment |

WARN (git_commit unstamped) clears with fix #1's deploy: the value is read
at runtime from `GIT_COMMIT_SHA`, which will be added to the task-def
revision that rolls the new image.

## Once ECR push is granted

1. `docker push .../vitana/gateway:12b0542` + `:latest` (image is staged locally)
2. Register `vitana-gateway` task-def revision: image pin + `GIT_COMMIT_SHA=<sha of 12b0542>`
3. `aws ecs update-service` → wait stable → verify `/api/v1/discover/feed`
   answers JSON via `preview-aws-gateway.vitanaland.com` and preflight from
   `preview-aws.vitanaland.com` returns `Access-Control-Allow-Origin`
4. Re-run the suite → expected **1 FAIL** (frontend bundle), which then
   needs only the `vitana-v1` rebuild to reach full parity

## Live-change ledger (all must reach IaC)

| Change | Where it lives now |
|--------|--------------------|
| ECS↔ALB attachments (gateway :8080, community-app :8080) | live only |
| Gateway TG health check `/health` → `/alive` | live only |
| Task def `vitana-gateway:5` (`VITANA_ENV=staging`) | live only |
| ALB host rule P30 `preview-aws.vitanaland.com` → community TG | live only |
| CORS allowlist for AWS staging hostnames | branch commit `12b0542` (merge to `main` so future images keep it) |
