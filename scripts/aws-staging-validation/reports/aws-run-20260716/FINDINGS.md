# AWS staging validation run — 2026-07-16

First live run of the parity suite (PR #2887) against the real AWS account,
using read-only credentials (`arn:aws:iam::472838866351:user/claude-staging-validation`).

## Verdict

**RESULT: FAIL — the AWS staging environment is not reachable from the public
internet.** Every one of the 8 failing checks in `parity-report.md` traces to a
single root cause: the ALB serves `503 Service Temporarily Unavailable` for
every path because **no targets are registered behind it**.

## What was found (account 472838866351)

All compute lives in **eu-central-1** (not eu-north-1 — that region is empty;
the tfstate bucket is `vitana-tfstate-eu-central-1`).

| Piece | State |
|-------|-------|
| ALB `vitana-alb-prod` | internet-facing, HTTPS :443 with ACM cert `vitanaland.com` + `*.vitanaland.com`, HTTP :80 → 443 redirect |
| ALB routing | `/api/*`, `/ws/*` and default → `vitana-tg-gateway-prod` (:8080); `/community`, `/community/*` → `vitana-tg-community-prod` (:80) |
| `vitana-tg-gateway-prod` | **0 registered targets** |
| `vitana-tg-community-prod` | **0 registered targets** |
| ECS cluster `Vitana-ECS-Cluster` | 28 services, incl. `vitana-gateway` and `vitana-community-app`, both ACTIVE 1/1 running, steady state |
| ECS `loadBalancers` config | **empty (`[]`) on both `vitana-gateway` and `vitana-community-app`** — the services never register their tasks into the target groups |
| Task networking | private IPs only (10.0.x.x, sg `vitana-sg-ecs-app`), no public IPs — ALB is the only public entry |
| Gateway task env | `ENV=staging`, RDS `vitana-postgres-staging`, Redis `vitana-redis-staging`, `GATEWAY_URL=http://gateway.vitanaland.com` |
| DNS | no `vitanaland.com` subdomain points at the ALB; `gateway.vitanaland.com` resolves to a **Google** IP (34.111.235.0 — the GCP stack). Route53 is not in this account. |

The gateway container passes its ECS container health check (service events
show a prior task replaced after failing health checks, then steady state), so
the app itself boots — it is simply not wired to the ALB.

## Root cause

`aws_ecs_service` for `vitana-gateway` / `vitana-community-app` is missing its
`load_balancer` block (or the equivalent wiring was never applied): target
groups exist, listener rules exist, services run — but the two are not
connected, so the ALB has nothing to forward to and answers 503 everywhere.

## Required fixes before re-running the parity suite

1. **Attach ECS services to the target groups** — add `load_balancer`
   config (gateway → `vitana-tg-gateway-prod` container port 8080,
   community-app → `vitana-tg-community-prod` container port 80) and verify
   targets go `healthy`. Note: adding a load balancer to an existing ECS
   service requires a service update/replacement depending on platform.
2. **Verify the target-group health checks** match the app (`/alive` on 8080
   per platform canon — never `/healthz`).
3. **Create DNS records** for the AWS staging hostnames (e.g.
   `aws-staging-gateway.vitanaland.com` / `aws-staging.vitanaland.com` →
   ALB alias). The ACM wildcard already covers any `*.vitanaland.com` name.
   Until then the suite can only reach the ALB via its raw DNS name with
   TLS verification disabled (cert mismatch), which is how this run was done.
4. **Frontend serving model decision** — ALB routes the frontend under
   `/community` path prefix, while GCP staging serves it at the domain root.
   The SPA's router/base path and SPA-fallback behavior must be configured
   for whichever shape is chosen, or parity checks (SPA fallback, bundle
   wiring) will keep failing even after targets register.

## Once reachable, re-check specifically

- `env=staging` from `/api/v1/admin/health` (task env already sets `ENV=staging`;
  confirm the gateway reads it as `VITANA_ENV` equivalent),
- Supabase host parity (`inmkhvwdcuyhnxkgfvsb.supabase.co`),
- `git_commit` stamped in build-info,
- CORS `Access-Control-Allow-Origin` for the AWS frontend origin,
- WebSocket upgrade through the ALB (idle timeout / upgrade support for ORB),
- baked gateway URL + Supabase URL in the frontend bundle.

## Method notes

- Run from a sandbox whose egress proxy is TLS-intercepting; AWS CLI v2
  installed ad hoc; snapshots captured with
  `capture-snapshot.sh` via a `curl -k` wrapper because the ALB has no
  cert-matching DNS name yet (see fix 3).
- Reference snapshot (`snap-gcp/`) captured live from
  `preview-gateway.vitanaland.com` / `preview.vitanaland.com` during the same
  run — the committed `baselines/gcp-20260716` lacks the `*.meta.json` files
  the comparator reads for the reachability row, so comparing against the
  committed baseline shows one spurious `gcp gateway reachable FAIL`.
  Live-vs-live (`parity-report.md` here) is the authoritative result.
- The "Route mounts PASS / 103 extra prefixes" rows are artifacts of the 503:
  the prober classifies any non-404 answer as "mounted", and an ALB 503 is
  non-404. They carry no signal until the gateway is reachable.
