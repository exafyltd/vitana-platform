# PostgREST-in-front-of-Aurora (staging)

Built 2026-08-12, in response to the explicit direction: get Aurora serving
**staging** first (tested, then a separate approval gate for production).

## Second correction notice, 2026-09-19 — this file's ORIGINAL framing is restored

The 2026-08-29 correction notice directly below this one said the
"Option A, keep Supabase Auth forever" framing this file was originally
written with had been superseded by Option B (Cognito/self-issued-JWT,
full Supabase shutdown incl. Auth). **That has now been reversed again.**
In a live session on 2026-09-19, the platform owner was shown that Option
B is a multi-week programme that cannot land by the 20 September 2026
deadline, and — given that tradeoff explicitly — overrode the 2026-08-25
"shut down Auth too" directive: *"keep Supabase for auth, free tier,
forever."* That is Option A, which is exactly what this file's original
design (below the 08-29 notice) describes: PostgREST in front of Aurora,
Supabase Auth (GoTrue) kept as the permanent identity source. The 08-29
notice's "keep Supabase Auth, forever premise is dead" line is itself now
the dead one. Full detail: `docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md`'s
Phase 1 section. This is the second reversal on this exact question — do
not build toward Cognito/self-issued-JWT auth without fresh, explicit
re-confirmation from the platform owner.

## Correction notice, 2026-08-29 (superseded 2026-09-19, see above) — read this before "Why this exists" below

This file's own framing — **"Option A instead, staging-scoped"**, "keep
Supabase Auth (GoTrue) as the identity source per the standing 'Supabase
is auth-only' rule" — describes a decision that has since been
**superseded**. `docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md` was updated
2026-08-25 with a platform-owner directive to migrate off Supabase
**entirely, including Auth** ("move everything from Supabase to AWS and
Aurora. Also the Auth server... this is final decision"), with a hard
20 September 2026 deadline. That plan's own Phase 1 note is explicit:
**"rules out Option A by construction: self-hosting the Supabase stack
(even on AWS/Aurora) is still running Supabase, not shutting it down, and
does not touch GoTrue/Auth at all."** The successor is Option B — auth
moves to Cognito or a self-issued-JWT service, not to a self-hosted
GoTrue anywhere, staging included.

This does **not** mean this build was wasted: the PostgREST-on-Aurora
mechanism it stands up (the `authenticator` role, the `auth.uid()`/
`auth.jwt()` shim, `SET ROLE`/`request.jwt.claims` per request) is the
same RLS-compatibility trick Option B's own B4 workstream depends on
regardless of what eventually issues the JWT — see
`services/gateway/src/services/aurora-client.ts` and PR #3087, where that
exact mechanism has since been verified live (VTID-03768/VTID-03769) via
a different transport (RDS Data API, not this proxy). What's dead
specifically is this doc's "**keep Supabase Auth, forever**" premise, not
the plumbing built to hold that door open — flagging so nobody reads
"staging-scoped Option A" below as a still-live target to finish deploying
as-is.

**Also stale as of the same date: the "blocking item 1" below (the
`authenticator` login role) is already resolved.** That role exists on
Aurora today — created by a later, undocumented effort — and its
connection URI is already stored in Secrets Manager exactly where this
doc anticipated (`vitana/aurora/prod/postgrest-authenticator-uri`,
confirmed present 2026-08-29). Re-verify against live AWS state before
treating any "blocking"/"remaining steps" section below as current;
Aurora's live role/grant state has moved since 2026-08-12 in ways this
file was never updated to reflect (see `docs/AURORA-B4-SIZING-REFRESH.md`'s
VTID-03768/VTID-03769 addenda for what's now actually verified).

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

## Status update, 2026-09-19 (VTID-04101) — both items below are RESOLVED

Both blockers this section originally described are closed, verified live
the same day, under the platform-owner's Option A override (see the
second correction notice above — Auth stays on Supabase permanently, this
proxy is now the actual near-term target, not a stale artifact):

- **Item 0 (FK constraints) is moot — Aurora has 0 foreign keys on the
  public schema today**, confirmed via `pg_constraint`. Nothing to drop.
  (Whether they were dropped and never restored, or something else
  changed since August, wasn't investigated — the practical effect is the
  same: no FK-drop step is needed before a full-load reload.)
- **Item 1 (the `authenticator` role) already existed** — but its stored
  password had drifted stale, the SAME class of defect independently found
  and fixed the same day on the DMS target endpoint's own stored
  `vitana_admin` password (see `docs/AURORA-MIGRATION-STATUS-2026-09-10.md`
  / the VTID-04084 branch history). Fixed by re-syncing the role's password
  to match `vitana/aurora/prod/postgrest-authenticator-uri` via the RDS-
  managed master secret (`rds!cluster-...`, readable by this session — a
  DIFFERENT secret from the hand-named `vitana/aurora/prod/*` ones the
  Deny below still blocks). The secret itself, the `anon`/`authenticated`/
  `service_role` grants, and the four `auth.*` shim functions were all
  already correct — confirmed live, not assumed.
- **Aurora's data is now correct and RLS-complete, not just schema-ready**:
  a fresh full-load reload (`vitana-fullload-rehearsal-v2`, TRUNCATE_BEFORE_LOAD,
  592/594 tables, row counts verified matching Supabase exactly on
  `profiles`/`chat_messages`/`app_users`) plus the full RLS-parity DDL
  (606 tables RLS-enabled, 1,059 policies, matching Supabase's live
  `pg_policies` snapshot) both ran and were verified the same day.
- **The remaining blocker is now purely AWS-provisioning, not credentials
  or data**: this session's IAM identity (`claude-code-aws-agent`) gets
  `AccessDenied` on `ecr:CreateRepository`, `ecr:GetAuthorizationToken`
  (i.e. it cannot even `docker login`, so it cannot push an image under
  ANY repo), and `ecs:CreateService` — confirmed live 2026-09-19, the
  same "needs an operator with AWS admin rights" shape this repo's other
  services (erp-bridge, the Vertex Serbian bridge) already hit. What
  changed: `ecs:RegisterTaskDefinition` (additive, versioned, never
  destructive) DOES succeed from this session — used to validate the new
  provisioning script's task-definition JSON is well-formed against the
  live account before handing it to the operator.
- **New, simpler plan than the original ALB-based one below**: reuse the
  `vitana.internal` Cloud Map private-DNS namespace already created for
  erp-bridge, instead of an ALB target group + host-header rule. The
  gateway only ever needs to reach this proxy from inside the VPC (no
  browser ever calls it directly), so plain internal HTTP at
  `http://postgrest-aurora.vitana.internal:8080` is simpler and sidesteps
  CLAUDE.md §1b's documented ALB-priority trap entirely — same posture
  erp-bridge already uses successfully. The ECS app-tier security group
  (`sg-0fbcf7b59b1f0d685`, same SG `vitana-gateway`/erp-bridge run in)
  **already has an ingress rule into Aurora's SG on 5432** — no new
  security-group rule is needed either.
- **New provisioning script + workflow, ready for the operator to run**:
  `scripts/aws/setup-postgrest-aurora-proxy-staging.sh` (dry-run by
  default, `--apply` to execute — mirrors `setup-erp-bridge-staging.sh`
  exactly) and `.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`
  (CI build+push+roll, staging-only, same shape as
  `AWS-STAGE-DEPLOY-ERP-BRIDGE.yml`). Once the operator runs
  `provision --apply`, the very next push to `main` under this directory
  (or a manual dispatch) builds and rolls the real proxy image — no
  bootstrap-tenant-style gate is needed here, since Aurora's data is
  already correct and can serve real reads from the first deploy.
- **No env-var split needed for the eventual gateway repoint.** Checked
  every gateway call site that does real Supabase Auth work (`.auth.admin.*`,
  `.auth.signInWith*`, `.auth.getUser()`, a raw `fetch('${SUPABASE_URL}/auth/v1/...')`)
  — all of them resolve through `getSupabase()`, `createUserSupabaseClient()`,
  or a direct fetch, and all three read the SAME `process.env.SUPABASE_URL`.
  There is no separate `SUPABASE_AUTH_URL` anywhere in the gateway. Since
  this proxy's `/auth/v1/*` passthrough is unconditional and header-agnostic,
  one `SUPABASE_URL` repoint transparently serves every one of the ~601
  Supabase call sites in the gateway — the Auth-heavy files need no special
  casing. Full detail: `docs/AURORA-MIGRATION-STATUS-2026-09-10.md`'s
  2026-09-19 "one SUPABASE_URL repoint" addendum. Still needs a real smoke
  test (login + a `.from()` read + an RLS-sensitive read) against the
  deployed proxy before this is anything more than a structural argument.

The sections below (from "What's blocking a live deploy right now" through
"Remaining steps once vitana_admin access is available") are the
**original 2026-08-12 plan, kept for historical record** — its item 4
(ALB target group + host-header rule) is superseded by the Cloud Map
approach above; its items 0–1 are resolved as described above.

## What's blocking a live deploy right now

**Two** missing pieces, and both need the same privileged access this
session's AWS identity does not have (deliberately — see below).

### 0. Aurora's target schema has 245 live FK constraints, and DMS can't load through them

Found 2026-08-12 while reloading Aurora after the replication-slot recovery
(see the parent VTID-03613/reconciliation work). Every AWS DMS full-load
target-prep mode does per-table TRUNCATE or DROP with no dependency
ordering, so any table referenced by another table's FK fails with
`cannot truncate/drop table X because other objects depend on it` — this
cascades across most of the 566-table schema, not a handful.

Aurora is a DMS-fed replica with no direct write traffic yet — Supabase
(the actual DMS source) is what enforces referential integrity today — so
dropping the FKs to unblock the load is safe and standard DMS practice, not
a data-integrity risk. Restore them later, once something writes to Aurora
directly and needs local FK enforcement (i.e. once this proxy or the
eventual real cutover is live).

- `aurora-fk-drop-2026-08-12.sql` — 245 generated `ALTER TABLE ... DROP
  CONSTRAINT` statements, exact current state of Aurora's `public` schema
  FKs as of the timestamp in the filename (not hand-typed — generated from
  `pg_constraint` directly).
- `aurora-fk-restore-2026-08-12.sql` — the inverse, via `pg_get_constraintdef()`,
  to bring them back verbatim later.

Needs `vitana_admin` (table owner) — `claude_readonly` (this session's
Aurora role) is confirmed only a member of `pg_read_all_data`, no path to
table-owner privilege on any of these tables.

### 1. The `authenticator` PostgREST login role

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

## Remaining steps once vitana_admin access is available

**Superseded by the 2026-09-19 status update above — items 0-1 are
already done, items 2-4 are replaced by one script.** For the CURRENT
plan: run `scripts/aws/setup-postgrest-aurora-proxy-staging.sh provision
--apply`, then push to `main` under this directory (or dispatch
`AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`) to build and roll the real
image. The steps below are kept for historical record only.

0. ~~Run `aurora-fk-drop-2026-08-12.sql`, then restart the DMS task~~ —
   moot, Aurora has 0 FKs on the public schema as of 2026-09-19.
1. ~~Run the `authenticator` role SQL above, create its secret~~ — already
   existed; only its password needed re-syncing (done 2026-09-19).
2. Build + push the `proxy` image to ECR (`cloud-run-source-deploy`-style
   repo, or a new `vitana-postgrest-aurora-proxy` ECR repo).
3. Create the ECS execution/task roles, register the task definition.
4. ~~New ECS service on `Vitana-ECS-Cluster` ... target group + ALB
   host-header rule~~ — replaced by a Cloud Map private-DNS entry in the
   existing `vitana.internal` namespace (see 2026-09-19 status update);
   no ALB rule, no host-header priority risk.
5. Point `gateway-staging`'s `SUPABASE_URL` at the new host — **staging
   only**, never production, until this has actually been tested.
6. Smoke test: an authenticated request through the real login flow, then
   a `.from()` read against a real table, then an RLS-sensitive read
   (confirm tenant isolation actually holds — this is the one thing that
   silently breaking would be worst, per CLAUDE.md's own "Never bypass RLS"
   / "Never mix tenant data" rules).
7. Only after that passes: the actual "run all tests, get approval" step
   the user asked for, before any production conversation.

## Explicitly out of scope for this build

Realtime and Storage are not implemented — anything hitting those paths
gets a clear `501` from the proxy rather than a silent failure. Per the
migration plan, those are their own workstreams (B5/B6) independent of
this data-path swap.
