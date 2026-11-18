---
change_class: standard
---
# Plan: preview-gateway-recovery — staging-only recovery of the isolated preview gateway for plan sparring

change class: standard (infrastructure, services/gateway startup, a protected CI workflow, ops scripts)
scope: exafyltd/vitana-platform only. No production service, routing or data is changed. Sparring stays paused
until the owner releases it. Artifacts referenced below live in `.kiro/specs/preview-gateway-recovery/artifacts/`.
session: kiro-jtadic-202611180939-a2df

<!-- plan:begin -->
## Goal (owner, 2026-11-18)
> Keep preview-aws-gateway.vitanaland.com as the endpoint for plan sparring. Keep sparring paused while you prepare
> the staging-only recovery. Production routing and direct PostgREST access from the sparring workflow are out of
> scope. … Keep allocation disabled in isolated staging pending that decision. … Prepare the smallest reviewable
> deployment change for vitana-gateway-preview: staging-only credentials compatible with PostgREST revision 20,
> background jobs disabled, and a preview hostname rule evaluated before priority 10.

## 1. Today (verified read-only 2026-11-18)
- `vitana-gateway-preview` 0/0 on `vitana-gateway-preview:1` (hand-built 2026-11-17, not in any workflow). Its one run
  logged `SUPABASE_URL or SUPABASE_SERVICE_ROLE not set` (no service-role secret bound) and still started the product
  analytics rollup, four Jev schedulers and the autonomous engine: `GATEWAY_API_ONLY=true` is not read by any code on
  `main` (67897e6ce8). It runs with `vitana-ecs-task-role`, the task role of the production gateway
  (`vitana-gateway-awsdr:207`), and `vitana-ecs-task-execution-role` (GetSecretValue on every `vitana/*` and `rds!*`).
- Listener rule for `preview-aws-gateway.vitanaland.com` → `vitana-tg-gateway-preview` sits at **priority 31**; the path
  rule `/ws/*,/api/*` at priority 10 wins first, so every `/api/...` request goes to `vitana-tg-gateway-prod`
  (one stale target 10.0.12.213, Target.Timeout) → PLAN-SPAR `create retry: HTTP 504` (run 44175611802).
- `vitana-postgrest-aurora-proxy` 1/1 on `vitana-postgrest-aurora-staging:20` (registered by hand 21:33, not by
  `AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml`, which hard-codes the rehearsal authenticator URI). PostgREST
  connects to `vitana-aurora-staging` / `vitana` and loaded **0 relations**.
- Rev 20 verifies JWTs with `vitana/gateway/staging/supabase-jwt-secret`, recorded as "sha256-identical to
  vitana/supabase/prod/jwt-secret (verified 2026-08-06)" (`scripts/aws/setup-postgrest-aurora-proxy-staging.sh:98`).
- PLAN-SPAR authenticates with `secrets.GATEWAY_SERVICE_TOKEN`, a plain string compare against the gateway's
  `GATEWAY_SERVICE_TOKEN` (`services/gateway/src/middleware/require-service-or-admin.ts:53-56`). Staging and
  production bind that from `vitana/supabase/prod/service-role-key` (`AWS-STAGE-DEPLOY-GATEWAY.yml:1121`), so the repo
  secret is the production Supabase service-role key; 19 workflows send it.
- No CI identity can deploy the preview: `vitana-gha-staging-deploy` may UpdateService only on `vitana-gateway`,
  `-kiro-runner`, `-erp-bridge`, `-postgrest-aurora-proxy`, `-community-app-staging`, and has no ELB write;
  `vitana-gitlab-deploy-role`'s staging job targets `vitana-gateway` only.

## 2. Credentials: why "staging-only" and "compatible with revision 20" cannot both hold
A service-role key that revision 20 accepts must be signed with revision 20's JWT secret, which is recorded as equal
to the production Supabase JWT secret. Such a key would also be a valid **production** `service_role` key. The
smallest change that makes the credential staging-only is a proxy revision that differs from revision 20 in exactly
one binding (`artifacts/proxy-jwt-staging.sh plan` shows the one-line diff):
`PGRST_JWT_SECRET` → `vitana/gateway/staging/postgrest-jwt-secret` (created 2026-11-17, tags `VTID=VTID-05803`,
`Environment=staging`; `vitana-gateway-preview:1` already uses it as `SUPABASE_JWT_SECRET`). Everything else of
revision 20 (image `staging-817e1d3e3d56`, `PGRST_DB_URI` ← `vitana/gateway/staging/postgrest-authenticator-uri`,
host `vitana-aurora-staging`) is unchanged. **Owner decision D1:** accept revision 21 with this one change (recommended),
or keep revision 20 and accept a production-valid key on the preview.

Preview credentials (all staging, all Secrets Manager, `artifacts/setup-preview-secrets.sh`, admin-run, dry run by
default, values never printed, refuses if the staging JWT secret equals the production one):
| Binding | Secret | Source |
|---|---|---|
| `SUPABASE_SERVICE_ROLE` | `vitana/gateway/staging/postgrest-service-role-key` (new) | HS256 `{role:service_role}` signed with the staging PostgREST secret, 180-day expiry |
| `SUPABASE_JWT_SECRET` | `vitana/gateway/staging/postgrest-jwt-secret` | existing |
| `GATEWAY_SERVICE_TOKEN` | `vitana/gateway/staging/preview-sparring-token` (new, random) | mirrored to repo secret `PLAN_SPAR_GATEWAY_TOKEN` |
| `GATEWAY_INTERNAL_TOKEN`, `DEEPSEEK_API_KEY`, `PLAN_SPARRING_GITHUB_TOKEN` | existing staging / GitHub-read secrets | unchanged |
Roles: new `vitana-gateway-preview-task-role` (Bedrock invoke only) and `vitana-gateway-preview-execution-role`
(GetSecretValue on the six secrets above only), `artifacts/iam-preview-roles.json`.

## 3. VTID allocation: verified with allocation disabled, one canonical ledger
- Sparring never calls the allocator: create / rounds / policy approval live in
  `services/gateway/src/services/plan-sparring/plan-sparring-service.ts` and touch only `plan_sparring_sessions`
  and `plan_sparring_append_round`. PLAN-SPAR allocates only when `vars.PLAN_SPAR_ALLOCATE == 'true'`
  (`scripts/collab/plan-spar.mjs:446`); otherwise it records "VTID allocation is off" and stays green.
- Disabled four ways on isolated staging: `VTID_ALLOCATOR_ENABLED=false`; no `system_controls` table in the restore
  (`isVtidAllocatorEnabled()` → no row → false, `system-controls-service.ts:418-430`); `LEDGER_WRITE_AUTH_MODE=enforce`;
  and the PLAN-SPAR change below forces `PLAN_SPAR_ALLOCATE=false` whenever the preview token is in use. The staging
  `global_vtid_seq` restarts at 90000, so even a mistake cannot mint a number that looks official.
- Verification reads: `GET /api/v1/vtid/allocator/status` (expects disabled), and the sparring run's `verdict.md`
  ("allocation is off"), `handoff.md` (no `vtids`), and `select count(*) from vtid_ledger` = 0 on staging.
- **One canonical ledger (owner decision D2, not taken here).** The sparring gate is inside the database:
  `_plan_sparring_gate_eval` looks the session up in the same database as the `vtid_ledger` insert
  (`20261015180000_vtid_05214_plan_sparring_policy_approval.sql:84-104`). A session sparred on Aurora staging cannot
  authorise an official VTID in the production ledger. Options to decide:
  (a) official allocation stays on the production ledger and re-spars there once a production-data sparring
      gateway exists; (b) the production allocator accepts a sparring record exported from staging (new code:
      signed record + hash check, protected files `supabase/migrations/*plan_sparring*.sql`,
      `services/gateway/src/services/plan-sparring/**`); (c) break-glass allocation by the owner only
      (CLAUDE.md rule 55, `vitana_governance_owner`, logged `vtid.plan_sparring.break_glass`, full sparring in 24 h).
  Until D2 is decided, allocation stays disabled on isolated staging.

## 4. VTID-05803 restore for sparring (schema only, no data, no production read)
Neither existing package restores an empty database: PR #5116's `schema-restore.sh` package is a delta on top of a
DMS-loaded schema (`aurora-cutover-schema-sync.sql:14` alters `public.agents_registry`, which nothing creates) and has
no roles or extensions; PR #5104 is a full data restore (production export incl. `auth.users`) blocked at export.
This plan restores only what sparring needs, from files already on `main` (sha256-pinned in
`artifacts/restore-sparring-schema.sh`, one transaction, dry run by default):
| # | File | sha256 |
|---|---|---|
| 0 | PR #5104 `docs/validation/VTID-05803/migration/00-supabase-roles-and-auth.sql` (roles anon/authenticated/service_role, auth helpers) | d600eefc…c7b5 |
| 1 | `supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql` | 9afe19d8…598d |
| 2 | `supabase/migrations/20260628120000_fix_allocate_global_vtid_seq_drift.sql` | e1378958…24fe |
| 3 | `supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql` | 80bc5878…26ff |
| 4 | `supabase/migrations/20261004120000_vtid_04868_plan_sparring_hardening.sql` | 2eaec169…3796 |
| 5 | `supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql` | a58bd379…22f5 |
| 6 | `artifacts/restore-sparring-grants.sql` (vtid_ledger revokes of 20260712110000, `GRANT anon, authenticated, service_role TO authenticator`, sequence at 90000, `NOTIFY pgrst`) | — |
- Target: cluster `vitana-aurora-staging` (PostgreSQL 17.9, tags `VTID-05803`/`staging`), writer
  `vitana-aurora-staging-writer.cfk228aiedf3.eu-central-1.rds.amazonaws.com`, database `vitana`. Host guard refuses
  `*prod*|*rehearsal*|*awsdr*|*postgres-staging*`; refuses unless `public` has 0 tables.
- Credential: the existing RDS-managed master secret (`rds!cluster-4fde6530-…-1OLLCc`, owner `rds`, rotation on,
  KMS key `6a766210-…`), user `vitana_staging_admin`. No new DDL secret; the stale `vitana/aurora/staging/database-url`
  (dead `vitana-postgres-staging`) and `vitana/aurora/staging/master-password` (tagged `Environment=prod`) are not used.
- Minimum permissions of the person who runs it: `rds:DescribeDBClusters` on the cluster,
  `secretsmanager:GetSecretValue` on that one secret ARN, `kms:Decrypt` on key `6a766210-…` via Secrets Manager, and a
  VPC CloudShell environment (`vpc-05958f035e596fe64`, `subnet-0ff45a2051c5e5482`, `sg-0a8531c0ec2130457`). In the
  database: the master user (needs CREATE ROLE incl. `BYPASSRLS` for `service_role`, CREATE on `vitana`, ADMIN on the
  new roles). Unverified: whether Aurora's `rds_superuser` may create a `BYPASSRLS` role; the transaction rolls back
  on the first statement if not.
- **Owner decision D3:** approve these files and this target (migration stop, collaboration.md §7d).
- Database owner's action: in VPC CloudShell, `git clone` the repo at `origin/main`, then
  `bash .kiro/specs/preview-gateway-recovery/artifacts/restore-sparring-schema.sh --repo <checkout>` (dry run), then the
  same with `--apply`; paste the post-check output into the lane log.

## 5. Deployment change and how it can land
Code: GATEWAY_RUNTIME_PROFILE (draft PR #5110, merges cleanly on 67897e6ce8) is required; without it the ungated
timers above keep running. `artifacts/preview-gateway.sh` refuses an image whose commit lacks
`services/gateway/src/runtime/runtime-profile.ts`. Env overlay: `artifacts/preview-taskdef-overlay.json`
(`GATEWAY_RUNTIME_PROFILE=preview-sparring` + every boot flag off + action-capable request features off; refuses any
production-shaped value or name). Rule: priority 31 → 8 (free; below the DR host rules 1–7, above path rule 10).

**Approved path while PLAN-SPAR is unavailable: none complete.** Every piece needs either a VTID (sparring is the
thing being repaired; break-glass rule 55 is owner-only) or a write no CI identity is allowed to make. One-time changes
for a separate owner decision (D4), in order, each with its rollback:
| # | Change | Who | Rollback |
|---|---|---|---|
| 1 | Create the two preview IAM roles (`iam-preview-roles.json`) | IAM admin (owner or Dragan) | delete both roles |
| 2 | `setup-preview-secrets.sh --apply --github` (2 secrets + repo secret `PLAN_SPAR_GATEWAY_TOKEN`) | owner/admin | delete the 2 secrets and the repo secret |
| 3 | Restore (§4), `restore-sparring-schema.sh --apply` | database owner (Dragan) after D3 | `DROP` of the created objects; the cluster held nothing before |
| 4 | Proxy revision 21 (`proxy-jwt-staging.sh apply`) after D1 | owner/admin | `proxy-jwt-staging.sh rollback` (back to :20) |
| 5 | Land #5110 on `main` (VTID by break-glass, reviewer accept, §7b merge); the push auto-builds `vitana/gateway:<sha12>` | owner allocates; Kiro builds and lands | revert commit (profile defaults to `full`) |
| 6 | `preview-gateway.sh plan` then `apply --commit <merge sha>` (task def, rule → 8, desired 1, healthy target) | owner/admin | `preview-gateway.sh rollback` (task def :1, desired 0, rule → 31) |
| 7 | PLAN-SPAR token lane (`plan-spar-token.patch`, protected file) | Kiro builds; owner instruction naming this plan + reviewer accept | revert, or delete `PLAN_SPAR_GATEWAY_TOKEN` |
| 8 | Release sparring (owner): re-run one paused `plan(` PR, e.g. #5115 | owner releases; Kiro runs | — |

## 6. Verification once deployed (read-only except the sparring run itself)
`preview-gateway.sh verify`: target healthy; rule < 10; `GET /alive` 200; `GET /api/v1/admin/build-info` commit =
the merge sha, env staging; authenticated `GET /api/v1/plans/spar/<unknown uuid>` = JSON 404 (token accepted, gateway
→ PostgREST → Aurora staging read OK; 401 = auth, 5xx = database); `GET /api/v1/vtid/allocator/status` = disabled.
Then one full PLAN-SPAR run: rounds written, converged or escalated by the partner, `verdict.md` "allocation is off".
Report the sparring result and the allocation status separately.

## 7. Unchanged
`vitana-gateway`, `vitana-gateway-awsdr`, every production rule and service, `PLAN_SPAR_GATEWAY_URL` (default stays
`preview-aws-gateway.vitanaland.com`), direct PostgREST access (none from CI). Note: once rule 31 moves to 8, every
`/api/*` call to the preview hostname (STAGING-VERIFY, `preview-aws.vitanaland.com`) reaches the isolated preview,
whose database holds only the sparring schema; today those calls already fail (504).

## Lanes (path-free in this plan PR; authoritative paths here)
- `runtime-profile` — adopt #5110: `services/gateway/src/**`, `services/gateway/test/runtime/**`.
- `preview-ops` — `scripts/aws/preview-gateway/**` (the artifacts, with tests), `docs/validation/<VTID>/**`.
- `plan-spar-token` — `.github/workflows/PLAN-SPAR.yml` (protected), depends on `preview-ops`.
- `incident-record` — `docs/ops/2026-11-17-preview-gateway-scale-down.md` (from `artifacts/2026-11-17-scale-down-record.md`).
<!-- plan:end -->
