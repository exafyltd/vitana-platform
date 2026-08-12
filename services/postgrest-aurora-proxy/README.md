# PostgREST-in-front-of-Aurora (staging)

Built 2026-08-12, in response to the explicit direction: get Aurora serving
**staging** first (tested, then a separate approval gate for production).

## Why this exists

`docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md`'s headline finding still holds:
the gateway has zero Postgres driver — it speaks HTTP to Supabase's
PostgREST API (2,280+ `.from()` calls, 270+ `.rpc()` calls). Aurora is just
Postgres; there is no PostgREST in front of it, so there is no connection
string to swap. The plan's Option B (rewrite every call site to raw
Postgres, replace Supabase Auth) is a real multi-week programme — not
appropriate to rush for a staging validation pass.

This is **Option A instead, staging-scoped**: stand up real PostgREST in
front of Aurora, keep Supabase Auth (GoTrue) as the identity source per the
standing "Supabase is auth-only" rule, and repoint the gateway's
`SUPABASE_URL` (staging only) at this proxy. Every existing `.from()` /
`.rpc()` call site works completely unchanged, because it's still talking
to a PostgREST-shaped API — just one backed by Aurora instead of Supabase's
managed Postgres.

## How it works

Two containers in one ECS task:

- **`proxy`** (nginx, this directory) — the only thing exposed to the ALB.
  Routes `/auth/v1/*` straight through to real Supabase (unchanged auth),
  and rewrites `/rest/v1/<table>` → PostgREST's `/<table>`,
  `/rest/v1/rpc/<fn>` → PostgREST's `/rpc/<fn>`.
- **`postgrest`** (official `postgrest/postgrest` image) — connects to
  Aurora as the `authenticator` role, verifies the same JWTs Supabase's
  GoTrue issues (same `PGRST_JWT_SECRET`), and does `SET ROLE`/reads
  `request.jwt.claims` per request — which is exactly what
  `scripts/aurora/migrations/0001_auth_shim.sql`'s `auth.uid()` /
  `auth.jwt()` / `auth.role()` / `auth.email()` functions were written to
  read. **Confirmed already live on Aurora** (checked 2026-08-12): all four
  shim functions and the `anon`/`authenticated`/`service_role` roles from
  `0000_auth_roles.sql` already exist — that groundwork from PR #3087 is
  done, this build doesn't need to repeat it.

## What's blocking a live deploy right now

One missing piece, and it needs privileged access this session's AWS
identity does not have (deliberately — see below):

**The `authenticator` login role PostgREST connects as.** Needs
`CREATEROLE`, which `vitana_admin` has and `claude_readonly` (this
session's role) does not. Run against Aurora, by whoever holds
`vitana_admin` credentials:

```sql
CREATE ROLE authenticator WITH LOGIN NOINHERIT PASSWORD '<generate one>';
GRANT anon, authenticated, service_role TO authenticator;
```

Then store the full connection URI (not JSON — `PGRST_DB_URI` wants the
literal `postgres://...` string) as a Secrets Manager secret, e.g.
`vitana/aurora/prod/postgrest-authenticator-uri`:

```
postgres://authenticator:<password>@vitana-aurora-prod.cluster-cfk228aiedf3.eu-central-1.rds.amazonaws.com:5432/vitana
```

This session's IAM identity (`claude-code-aws-agent`) has an explicit Deny
on `secretsmanager:GetSecretValue` for the Aurora master secret and no
`CreateSecret` grant at all — both required for this step. That's very
plausibly a deliberate tightening after today's earlier incident (an
empty-password lockout on this same cluster), not a bug to route around.

## What's already done, ready to deploy once unblocked

- `nginx.conf.template` / `Dockerfile` — the proxy, complete.
- `task-definition.template.json` — ECS Fargate task, both containers
  wired, health checks, log groups. Placeholders (`REPLACE_WITH_*`) for the
  execution/task role ARNs (need creating — standard ECS task role, no
  special privileges beyond pulling the image and writing logs) and the
  authenticator secret ARN from the step above.

## Remaining steps once the authenticator role/secret exist

1. Build + push the `proxy` image to ECR (`cloud-run-source-deploy`-style
   repo, or a new `vitana-postgrest-aurora-proxy` ECR repo).
2. Create the ECS execution/task roles, register the task definition.
3. New ECS service on `Vitana-ECS-Cluster` (same cluster as AWS staging
   gateway), target group + ALB host-header rule
   (`aurora-staging-rest.vitanaland.com` or similar — remember: priority
   **< 10**, the path-based rules at priority 10 route to staging
   regardless of `Host` otherwise, per CLAUDE.md §1b's documented trap).
4. Point `gateway-staging`'s `SUPABASE_URL` at the new host — **staging
   only**, never production, until this has actually been tested.
5. Smoke test: an authenticated request through the real login flow, then
   a `.from()` read against a real table, then an RLS-sensitive read
   (confirm tenant isolation actually holds — this is the one thing that
   silently breaking would be worst, per CLAUDE.md's own "Never bypass RLS"
   / "Never mix tenant data" rules).
6. Only after that passes: the actual "run all tests, get approval" step
   the user asked for, before any production conversation.

## Explicitly out of scope for this build

Realtime and Storage are not implemented — anything hitting those paths
gets a clear `501` from the proxy rather than a silent failure. Per the
migration plan, those are their own workstreams (B5/B6) independent of
this data-path swap.
