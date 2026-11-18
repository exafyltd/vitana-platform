---
change_class: standard
---
# Plan: preview-gateway-recovery — staging-only recovery of the isolated preview gateway for plan sparring

change class: standard (infrastructure, services/gateway startup, a protected CI workflow, ops scripts)
scope: exafyltd/vitana-platform (+ one vitana-v1 steering fix, §5). No production service, route or data changes.
Sparring stays paused until the owner releases it. Artifacts: `.kiro/specs/preview-gateway-recovery/artifacts/`.
session: kiro-jtadic-202611180939-a2df

<!-- plan:begin -->
## Goal and owner decisions (2026-11-18)
> Keep preview-aws-gateway.vitanaland.com as the endpoint for plan sparring. … Production routing and direct
> PostgREST access from the sparring workflow are out of scope.
- **D1** proxy revision 21 with the staging-only PostgREST JWT secret; a separate preview token for PLAN-SPAR; verify
  staging credentials work and production credentials are rejected, without exposing values.
- **D2** official allocation deferred; allocation disabled for preview sparring; an end-to-end run is recovery
  evidence only; document what the canonical ledger would need (`artifacts/canonical-ledger-acceptance.md`).
- **D3** schema-only restore on `vitana-aurora-staging` / `vitana`, rehearsed on a disposable database first; no
  staging counter change unless needed (it is not; removed).
- **D4** one-time recovery prepared for review; push guard fixed through the normal process; exact protected changes
  and VTID action named; listener change checked against the staging frontend and STAGING-VERIFY first.

## 1. Today (verified read-only 2026-11-18)
- `vitana-gateway-preview` 0/0 on `:1` (built by hand 2026-11-17); no service-role secret; `GATEWAY_API_ONLY` is read
  by no code on `main`; runs with the production gateway's task role `vitana-ecs-task-role`.
- Host rule `preview-aws-gateway.vitanaland.com` → `vitana-tg-gateway-preview` at priority 31; path rule `/ws/*,/api/*`
  at 10 wins first, so every `/api/...` request goes to `vitana-tg-gateway-prod` (staging `vitana-gateway`, 0 tasks,
  one stale target) → PLAN-SPAR `HTTP 504`. Non-`/api` paths (`/alive`, `/command-hub/*`) already reach the preview
  target group through rule 31.
- `vitana-postgrest-aurora-proxy` 1/1 on `vitana-postgrest-aurora-staging:20`; Aurora staging `vitana` has 0 tables.
  Rev 20 verifies JWTs with `vitana/gateway/staging/supabase-jwt-secret`, recorded as identical to the production
  Supabase JWT secret (`scripts/aws/setup-postgrest-aurora-proxy-staging.sh:98`).
- PLAN-SPAR's `secrets.GATEWAY_SERVICE_TOKEN` is the production Supabase service-role key (string compare,
  `require-service-or-admin.ts:53-56`; bound from `vitana/supabase/prod/service-role-key`, `AWS-STAGE-DEPLOY-GATEWAY.yml:1121`).
- No CI identity may deploy the preview or write listener rules (`vitana-gha-staging-deploy` UpdateService list; no ELB write).

## 2. Credentials (D1)
| Binding on the preview | Secret | Notes |
|---|---|---|
| `SUPABASE_SERVICE_ROLE` | `vitana/gateway/staging/postgrest-service-role-key` (new) | HS256 `{role:service_role}` signed with the staging PostgREST secret, 180 days |
| `SUPABASE_JWT_SECRET` | `vitana/gateway/staging/postgrest-jwt-secret` (exists, tags VTID-05803/staging) | also the proxy's `PGRST_JWT_SECRET` in rev 21 |
| `GATEWAY_SERVICE_TOKEN` | `vitana/gateway/staging/preview-sparring-token` (new, random) | copied to repo secret `PLAN_SPAR_GATEWAY_TOKEN` |
| `GATEWAY_INTERNAL_TOKEN`, `DEEPSEEK_API_KEY`, `PLAN_SPARRING_GITHUB_TOKEN` | existing staging / GitHub-read secrets | unchanged |
Proxy rev 21 = rev 20 with one binding changed (`proxy-jwt-staging.sh plan`, read-only, run against the live rev 20:
exactly one line differs). `setup-preview-secrets.sh` refuses to mint if the staging and production JWT secrets are
equal (sha256 compared in-process). Roles: `vitana-gateway-preview-task-role` (Bedrock invoke only) and
`vitana-gateway-preview-execution-role` (GetSecretValue on the six secrets only), `iam-preview-roles.json`.
Verification without exposing values: rehearsal section E (below) proves the JWT behaviour on PostgREST 12.2.3; after
deployment `preview-gateway.sh verify` (gateway: staging token → JSON 404, production key → 401, no token → 401) and
`proxy-jwt-staging.sh verify` from the VPC (proxy: staging key → 200, production key → 401). Secrets are read into a
variable for one request and never printed.

## 3. Allocation (D2)
Sparring never calls the allocator; PLAN-SPAR allocates only when `PLAN_SPAR_ALLOCATE == 'true'`
(`scripts/collab/plan-spar.mjs:446`). Disabled four ways: `VTID_ALLOCATOR_ENABLED=false`; no `system_controls` table
(rehearsal: PostgREST answers 404 for it, so `isVtidAllocatorEnabled()` reads no row → false); `LEDGER_WRITE_AUTH_MODE=enforce`;
and the PLAN-SPAR patch forces `PLAN_SPAR_ALLOCATE=false` whenever the preview token is in use. Evidence after a run:
`GET /api/v1/vtid/allocator/status` = `{ok:true, enabled:false, env_var_enabled:false, db_control:null}`, `verdict.md`
"allocation is off", no `vtids` in `handoff.md`, `vtid_ledger` 0 rows. Canonical ledger: `canonical-ledger-acceptance.md`.

## 4. Restore (D3) — rehearsed, ready for Dragan
Manifest `artifacts/restore-sparring.manifest` (apply order, full sha256):
| sha256 | file |
|---|---|
| 4c89a483aadda189f8c1901efbf7dba20579b3c2ae142aa01033308e80ac75f2 | `artifacts/00-sparring-roles.sql` |
| 9afe19d8a6fab3385adcb89ddfdce59c052c5c264b8f4447e2ddd2991316598d | `supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql` |
| e137895841d951c4054159bd6d723c219494e10376035e44472f95f5e3a824fe | `supabase/migrations/20260628120000_fix_allocate_global_vtid_seq_drift.sql` |
| 80bc587894c2efdfea3fbc44a9c7488afa46dbbea8e96e9ef952516ed48c26ff | `supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql` |
| 2eaec16934081fdf754eb831d95fdb806bd9c067cc03282077a005ba91cb3796 | `supabase/migrations/20261004120000_vtid_04868_plan_sparring_hardening.sql` |
| a58bd37974235c7a3117c7f8bad7efbefdcfb0110c11e3b7d9863300805122f5 | `supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql` |
| 4062f101e2602cd69836657661c64359dfc5da5ceb3c9a8143580481f58db523 | `artifacts/restore-sparring-grants.sql` |
Plus `precheck-sparring.sql` (read-only, runs first) and `rollback-sparring-schema.sql`.
- **Rehearsal** (`rehearse-restore.sh`, PostgreSQL 17.11 + PostgREST 12.2.3, Aurora-like master `NOSUPERUSER CREATEDB
  CREATEROLE NOBYPASSRLS` + `rds_superuser`, pre-existing `authenticator`): **40 passed, 0 failed**
  (`artifacts/rehearsal-output.txt`). Run 1 with PR #5104's unmodified roles file failed: `permission denied to create
  role` / "Only roles with the BYPASSRLS attribute may create roles with the BYPASSRLS attribute" → `00-sparring-roles.sql`
  creates `service_role` without BYPASSRLS (every restored table has an explicit service_role policy; the rehearsal
  proves insert, read, append_round and policy approval) and drops the unused auth/storage/extensions objects.
- **Ledger objects required even with allocation disabled:** `vtid_ledger` and `global_vtid_seq` (the gate migration
  creates its trigger, unique index, policy and grants on them, so it fails without them) and `plan_sparring_config`
  (the trigger reads it). The allocator functions come with the same files and stay unused; nothing is allocated.
- **Staging counter change:** not needed and removed (sequence stays at the migration default 1000).
- **Not one transaction:** three migrations carry their own `BEGIN/COMMIT`. A failure is undone with `--rollback`
  (rehearsal C: failure after 6 tables → rollback → 0 tables, roles and memberships removed → re-apply OK).
- **Refusals proven:** non-empty database (D); request roles created earlier by someone else without ADMIN OPTION for
  the master (B) — then the grant to `authenticator` could not succeed, so the precheck stops first.
- **Target:** cluster `vitana-aurora-staging` (tags VTID-05803/staging), writer
  `vitana-aurora-staging-writer.cfk228aiedf3.eu-central-1.rds.amazonaws.com`, database `vitana`, master
  `vitana_staging_admin` via the RDS-managed secret `rds!cluster-4fde6530-…-1OLLCc` (no new DDL credential).
- **Dragan's minimum permissions:** `rds:DescribeDBClusters` on the cluster; `secretsmanager:GetSecretValue` on that one
  secret; `kms:Decrypt` on key `6a766210-8918-424c-8f1c-f62d349f2e8a` via Secrets Manager; a VPC CloudShell
  (`vpc-05958f035e596fe64`, `subnet-0ff45a2051c5e5482`, `sg-0a8531c0ec2130457`) with psql 17 and jq.

## 5. Listener change (D4) — blast radius checked
The staging frontend bakes `https://preview-aws-gateway.vitanaland.com` into its bundle
(vitana-v1 `AWS-STAGE-DEPLOY-FRONTEND.yml:64,102,132-133`); REST, the ORB widget and its WebSocket
(`/api/v1/orb/live/ws`), and SSE all use it. STAGING-VERIFY's gateway smoke and change suites, the deploy smoke
(`AWS-STAGE-DEPLOY-GATEWAY.yml:1416-1447`), EventBridge crons (`setup-eventbridge-cron-migration.sh:101,108`), several
scheduled workflows, and **PUBLISH's staging source** (`services/gateway/src/services/aws-gateway-admin.ts:24-80` reads
`preview-aws-gateway…/api/v1/admin/build-info` and promotes the commit it reports when `env='staging'`) all call it.
A host-only rule before priority 10 would send all of them to the isolated preview; PUBLISH could then treat the
preview's commit as the tested staging build. **So the rule is exact host AND sparring paths only**, priority 8:
`host-header == preview-aws-gateway.vitanaland.com` AND `path-pattern ∈ {/api/v1/plans/spar, /api/v1/plans/spar/*,
/api/v1/vtid/allocator/status}` → `vitana-tg-gateway-preview`. Rule 31 is not changed. Only PLAN-SPAR's calls
(`plan-spar.mjs:157-182`) and the allocator status read move; two historical change suites (VTID-04868, VTID-05214)
probe `/api/v1/plans/spar/<id>` expecting 401 and would get that 401 from the preview. Everything else is unaffected.
Pre-existing (not changed here): `/alive` on the preview hostname already answers from the preview target group, so
STAGING-VERIFY's `alive` smoke does not prove the staging gateway is up.

## 6. Push guard and the landing path (D4)
The guard runs `scripts/collab/kiro-web-steering.test.mjs` case 6 against the workspace's real checkouts. It fails on
unchanged `main` because vitana-v1's `.kiro/steering/vitana-standing-rules.md` still links `CLAUDE.md` and
`.claude/CLAUDE.md`, which vitana-v1 #1691/#1692 removed on 2026-11-14. The fix already exists as commit `2af0822fb` in
draft vitana-v1 PR #1696 (mixed with unrelated Expo changes, no VTID). Normal process: that commit as its own lane.
Every lane needs a VTID, and VTIDs come from PLAN-SPAR, which this plan repairs: **the only path is owner break-glass
(CLAUDE.md rule 55)**. Minimum VTIDs: (1) vitana-v1 steering-link fix, (2) `runtime-profile` (#5110), (3)
`plan-spar-token`. The scripts and the record (`preview-ops`, `incident-record`) run from this branch and spar normally
once the preview is back. Protected changes: only `.github/workflows/PLAN-SPAR.yml` (needs the owner's instruction
naming this plan + a reviewer accept on the current head). The restore applies protected migration files unchanged
(no protected edit) and is the migration stop (§7d): D3 approval, run by Dragan. Rule 55 asks for a full sparring
within 24 h of a break-glass allocation; under D2 a preview sparring is evidence only, so the owner decides whether it
satisfies that clause.

## 7. Execution checklist (live changes, in order)
| # | Operator | Action | Rollback |
|---|---|---|---|
| 0 | Owner | Authorize: 3 break-glass VTIDs (§6); PLAN-SPAR.yml change (name this plan); D3 apply by Dragan | — |
| 1 | Kiro | Land the vitana-v1 steering-link lane (`2af0822fb`), reviewer accept, §7b merge; push this plan branch (no `plan(` PR while sparring is paused) | revert commit |
| 2 | IAM admin | Create the two roles in `iam-preview-roles.json` | delete both roles |
| 3 | Owner/admin | `setup-preview-secrets.sh` (dry run) → `--apply --github` | delete the 2 secrets; `gh secret delete PLAN_SPAR_GATEWAY_TOKEN` |
| 4 | Dragan | VPC CloudShell: `restore-sparring-schema.sh --repo <checkout>` (dry run, send output) → `--apply` | `--rollback` |
| 5 | Owner/admin | `proxy-jwt-staging.sh plan` → `apply` → `verify` (VPC) | `proxy-jwt-staging.sh rollback` (rev 20) |
| 6 | Kiro | Land `runtime-profile` (#5110); confirm image `vitana/gateway:<sha12>` in ECR | revert commit |
| 7 | Owner/admin | `preview-gateway.sh plan --commit <sha>` → `apply --commit <sha>` | `preview-gateway.sh rollback` |
| 8 | Kiro | Land `plan-spar-token` (owner instruction + reviewer accept) | revert, or delete `PLAN_SPAR_GATEWAY_TOKEN` |
| 9 | Kiro + operator | `preview-gateway.sh verify --commit <sha>`; `proxy-jwt-staging.sh verify` (VPC) | — |
| 10 | Owner → Kiro | Release sparring; Kiro opens/re-runs one `plan(` PR; report sparring result and allocation status separately | — |

## 8. Unchanged
`vitana-gateway`, `vitana-gateway-awsdr`, rule 31 and every other listener rule, `PLAN_SPAR_GATEWAY_URL`, the staging
frontend, STAGING-VERIFY targets, PUBLISH. The 2026-11-17 reason stays unconfirmed (`artifacts/2026-11-17-scale-down-record.md`).

## Lanes (path-free in this plan PR; authoritative paths here)
- `runtime-profile` — adopt #5110: `services/gateway/src/**`, `services/gateway/test/runtime/**`, its workflow lines.
- `preview-ops` — `scripts/aws/preview-gateway/**` (the artifacts and the rehearsal), `docs/validation/<VTID>/**`.
- `plan-spar-token` — `.github/workflows/PLAN-SPAR.yml` (protected), depends on `preview-ops`.
- `incident-record` — `docs/ops/2026-11-17-preview-gateway-scale-down.md`.
- vitana-v1 `steering-dead-links` — `.kiro/steering/vitana-standing-rules.md`, `.kiro/steering/vitana-execution-continuity.md`,
  `.claude/rules/execution-continuity.md`, `scripts/ci/kiro-steering/guard.cjs` (commit `2af0822fb`).
<!-- plan:end -->
