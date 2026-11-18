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

## 4. Restore (D3) — rehearsed; read-only Aurora precheck is next
Apply package (byte-identical since commit 3a3b9ec; `artifacts/restore-sparring.manifest`, apply order):
| sha256 | file |
|---|---|
| 4c89a483aadda189f8c1901efbf7dba20579b3c2ae142aa01033308e80ac75f2 | `artifacts/00-sparring-roles.sql` |
| 9afe19d8a6fab3385adcb89ddfdce59c052c5c264b8f4447e2ddd2991316598d | `supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql` |
| e137895841d951c4054159bd6d723c219494e10376035e44472f95f5e3a824fe | `supabase/migrations/20260628120000_fix_allocate_global_vtid_seq_drift.sql` |
| 80bc587894c2efdfea3fbc44a9c7488afa46dbbea8e96e9ef952516ed48c26ff | `supabase/migrations/20261004110000_vtid_04868_plan_sparring_gate.sql` |
| 2eaec16934081fdf754eb831d95fdb806bd9c067cc03282077a005ba91cb3796 | `supabase/migrations/20261004120000_vtid_04868_plan_sparring_hardening.sql` |
| a58bd37974235c7a3117c7f8bad7efbefdcfb0110c11e3b7d9863300805122f5 | `supabase/migrations/20261015180000_vtid_05214_plan_sparring_policy_approval.sql` |
| 4062f101e2602cd69836657661c64359dfc5da5ceb3c9a8143580481f58db523 | `artifacts/restore-sparring-grants.sql` |
- **Rehearsal** (PostgreSQL 17.11 + PostgREST 12.2.3, Aurora-like master): **44 passed, 0 failed**
  (`artifacts/rehearsal-output.txt`). Run 1 with PR #5104's roles file failed on `BYPASSRLS`; `00-sparring-roles.sql`
  creates `service_role` without it (explicit service_role policies on every restored table).
- **Required ledger objects with allocation disabled:** `vtid_ledger`, `global_vtid_seq`, `plan_sparring_config`
  (the gate migration's trigger, index, policy and grants need them). No counter change (stays 1000).
- **Precheck (read-only, `precheck-sparring.sql`, runs first in the dry run and in `--apply`).** Verifies: server
  version >= 16; database `vitana`; connected user and its attributes (superuser, createrole, createdb, bypassrls);
  its memberships (expect `rds_superuser`); database owner; CREATE on schema `public`; `public` empty (tables,
  functions, sequences/views); `anon`/`authenticated`/`service_role`/`vitana_governance_owner` absent; `authenticator`
  present, its attributes, and that it has no memberships yet; whether `auth`/`storage`/`extensions` exist. Refuses on
  any mismatch. **Cannot verify before applying:** that Aurora lets the master create the four roles (attribute check
  only; proven on the rehearsal's NOSUPERUSER master), that the master then holds ADMIN on them (PostgreSQL 16+ creator
  rule; rehearsal), and that PostgREST reloads its schema cache after `NOTIFY pgrst` (checked after the apply).
- **Exact rollback scope** (rehearsal section F, catalog snapshot before/after): the restore adds 54 catalog entries —
  6 tables (`vtid_ledger`, `plan_sparring_sessions`, `plan_sparring_config`, `plan_sparring_shadow_log`, `pm_digests`,
  `pm_lease`), 2 sequences (`global_vtid_seq`, `plan_sparring_shadow_log_id_seq`), 17 indexes, 8 functions
  (`allocate_global_vtid`, `plan_sparring_append_round`, `plan_sparring_check`, `_plan_sparring_gate_eval`,
  `_plan_sparring_mode`, `_plan_sparring_sessions_touch`, `plan_sparring_trigger_status`, `submit_plan_sparring_record`),
  8 policies, 2 triggers, 4 roles + 1 role comment, 7 memberships (3 to `authenticator`, 4 creator-ADMIN to the master)
  — and modifies exactly two pre-existing entries: the `public` schema ACL (USAGE for the 3 request roles) and the
  shared role-comment count. `--rollback` removes all of them; after it the catalog snapshot is **identical** to the
  one before the restore. What predates the restore is preserved because (a) the precheck refuses if any object or
  role the restore would create already exists, so nothing pre-existing can be in scope; (b) the rollback refuses if
  `public` holds any table outside the six; (c) it drops only the roles recorded in `restore-sparring-state.json` (the
  ones the precheck saw absent); (d) `authenticator`, the master user and every other role are never dropped; (e) the
  schema ACL is returned to its exact prior value (rehearsal diff = 0).
- **Partial commit:** three migrations carry their own BEGIN/COMMIT; after any failure `--rollback` (rehearsal C).

## 5. Listener change (D4, owner-accepted 2026-11-18) — sparring paths only
Rule at priority 8: `host-header == preview-aws-gateway.vitanaland.com` AND `path-pattern in {/api/v1/plans/spar,
/api/v1/plans/spar/*, /api/v1/vtid/allocator/status}` → `vitana-tg-gateway-preview`. Rule 31 is untouched.
Live routing evaluated read-only (`artifacts/routing-evaluation.txt`; `preview-gateway.sh plan` and `verify` repeat it
and refuse otherwise): with the planned rule, `/api/v1/admin/build-info`, `/api/v1/admin/health`, `/api/v1/orb/live/ws`
and `/api/v1/vtid/allocate` on the preview hostname stay on rule 10 → `vitana-tg-gateway-prod` (staging
`vitana-gateway`), exactly as today; only the three sparring paths move. PUBLISH reads
`preview-aws-gateway…/api/v1/admin/build-info` (`aws-gateway-admin.ts:24-80`), so its source stays the staging
gateway. **Today that gateway is at 0 tasks (2026-11-17 scale-down), so PUBLISH currently has no staging build to
resolve; this plan neither changes nor fixes that.** `verify` also fails if build-info ever reports the preview's commit.

## 6. Push guard, VTIDs and rule 55 (D4)
- **Push guard resolved through the repo's supported layout.** `kiro-web-steering.test.mjs` case 6 says "The CI
  checkout has only vitana-platform". In a clean single-repo clone every preflight check passes; the plan branch was
  pushed from it (`kiro/preview-gateway-recovery/plan` @ ad81cc27, no PR, so PLAN-SPAR did not run; DRIVER-WAKE
  answered "skip (not a plan event)"). The vitana-v1 steering fix (`2af0822fb`, #1696) proceeds on its own schedule.
- **Break-glass VTIDs genuinely needed: 2.** (1) `runtime-profile` (#5110): without it, kiro-run timers, the autonomous
  engine, the lifecycle worker, module-level timers, cache warms and the agents bootstrap start with no env switch
  (the four Jev schedulers can be switched off by `JEV_*_MODE=off`, now in the overlay). (2) `plan-spar-token`: without
  it PLAN-SPAR can only send the shared token, which is the production service-role key. Not needed: the vitana-v1
  steering fix (push guard resolved); `preview-ops` and `incident-record` (operator scripts run from this branch; they
  spar normally once the preview is back).
- **Rule 55, exact text** (CLAUDE.md:360-361): "**Break-glass** (P1 incident with gateway or Bedrock down): only the
  owner allocates through the exemption role, logged as `vtid.plan_sparring.break_glass`; a full sparring follows
  within 24h." The skill says the same ("A full sparring follows within 24 hours", `.claude/skills/plan-sparring/SKILL.md:86`);
  the reconciler only announces it ("post-hoc sparring due within 24h", `reconciler.ts:171`) and checks nothing after.
  The rule does not say where the sparring must be recorded. Read with rule 52 (independent partner, every finding
  answered, at least two passes) a complete preview run is a full sparring in substance; read with rule 54 ("The gate
  is the database") and IF-THEN 9 (prefer the stricter rule) it is not, because its record lives in Aurora staging and
  cannot be attached to the canonical ledger (D2, `canonical-ledger-acceptance.md`). It also leaves open whether this
  outage is the "P1 incident with gateway … down" the rule names (the production gateway is up; the sparring gateway
  is down). **Ambiguous. Only the owner can decide it** (rules 51–55 are owner decisions of 2026-10-03/04, and
  CLAUDE.md is a protected file the owner controls). It must be decided before the first break-glass insert: the
  reconciler starts the 24 h clock at that insert.

## 7. Execution checklist (live changes, in order; nothing runs before the owner's approval)
| # | Operator | Action | Rollback |
|---|---|---|---|
| 1 | Dragan | Read-only precheck (dry run) from the VPC CloudShell; send `restore-sparring-dryrun.txt` | none (read-only) |
| 2 | Owner | Decide rule 55 (preview run satisfies the 24 h clause or not); allocate the 2 break-glass VTIDs | — |
| 3 | IAM admin | Create the two roles in `iam-preview-roles.json` | delete both |
| 4 | Owner/admin | `setup-preview-secrets.sh` (dry run) → `--apply --github` | delete the 2 secrets and `PLAN_SPAR_GATEWAY_TOKEN` |
| 5 | Dragan | `restore-sparring-schema.sh --apply` (only after the dry-run result is reviewed) | `--rollback` |
| 6 | Owner/admin | `proxy-jwt-staging.sh plan` → `apply` → `verify` (VPC) | `proxy-jwt-staging.sh rollback` (rev 20) |
| 7 | Kiro | Land `runtime-profile` (#5110) with its VTID; image `vitana/gateway:<sha12>` in ECR | revert |
| 8 | Owner/admin | `preview-gateway.sh plan --commit <sha>` → `apply --commit <sha>` | `preview-gateway.sh rollback` |
| 9 | Kiro | Land `plan-spar-token` (prepared: `artifacts/plan-spar-token.patch`) after a reviewer accept on the PR head | revert, or delete `PLAN_SPAR_GATEWAY_TOKEN` |
| 10 | Kiro + operator | `preview-gateway.sh verify`; `proxy-jwt-staging.sh verify` (VPC) | — |
| 11 | Owner → Kiro | Release sparring; one full PLAN-SPAR run; report sparring and allocation separately | — |
While the preview token is set, a converged plan gets no VTIDs and `plan-spar.mjs` hands it to `next_actor: claude`
(stale wording; Claude Code is retired): every plan stops at convergence until D2 is settled.

## 7a. Failing case for the recovery (owner, 2026-11-18)
PR #5117 `plan(chat-reactions-full-emoji)` (head fcb8a504fe), PLAN-SPAR run 44292773682: attempt 1 (11:13Z) and the
owner's re-run, attempt 2 (11:16Z), both `plan-spar: create retry: HTTP 504` at session create against
`https://preview-aws-gateway.vitanaland.com`. The run log shows **`PLAN_SPAR_ALLOCATE: true`** (repository variable) and
the shared token. Cause unchanged: `/api/*` on the preview host still goes to rule 10 (staging `vitana-gateway`, 0 tasks);
`vitana-gateway-preview` is 0/0 on `:1`. Recovery is accepted when a PLAN-SPAR run on #5117 creates its session
through the isolated preview and completes a round with the preview token, with allocation off.
Consequences recorded for the owner:
- The re-run allowance for this head is used; a third run before the recovery would fail the same way.
- A re-run reuses the workflow of the original event, so once `plan-spar-token` is on `main` #5117 needs a new event
  (a push to its plan or responses file) to run with the preview token.
- With the variable at `true`, a run through the preview would attempt allocation; the preview refuses it
  (`allocator_disabled`, no `system_controls`) and the run stays green with `allocation_pending`. `plan-spar-token`
  forces it off. Optional immediate safeguard (owner, reversible, no VTID): set `PLAN_SPAR_ALLOCATE=false`.
- With allocation off, #5117 can spar to convergence but gets no VTID; it then waits for D2.

## 7b. Owner approval 2026-11-18 and execution pins
- **Approved:** steps 1–7 of the staging-only recovery (Aurora staging only; the emoji migration to the shared VITANA
  Supabase database stays pending). Every live step runs as an IAM identity, never the root user. IAM operator:
  `j.tadic@vitanaland.com` (AdministratorAccess, MFA on). `d.stevanovic@vitanaland.com` also has AdministratorAccess
  but no MFA device. Independent reviewer: `vitana-lane-reviewer` (installed, identical to `origin/main`; chain
  claude-sonnet-5.5 → claude-opus-5.5 → claude-sonnet-4.5), run on each lane PR's current head.
- **Pinned restore:** commit `9fa0d39093536a3775666d724485490f19ed0939`; `git archive --format=tar` of it has sha256
  `1b1214da75d28f2ed190e4ef48bec7f4af1e1043f33b891bc752d923c6f80ad8` (= the owner's `recovery2.tar` in the transfer
  bucket). Rehearsal from that exact archive: 60 passed, 0 failed. `--apply` and `--rollback` were also run end to end
  from it with the psql 16.15 client on a live-like database: apply exit 0, rollback exit 0, catalog identical after.
  The VPC CloudShell environment keeps no files after it times out, so the apply log and `restore-sparring-state.json`
  go to the transfer bucket right after the apply; the bucket stays until the recovery is accepted.
- **Rule 55 (owner decision, subject to confirmation by the rule owner):** a full preview sparring run with allocation
  disabled satisfies the 24 h follow-up. **One run covers both break-glass VTIDs** (`runtime-profile`,
  `plan-spar-token`): sparring is per plan and both are lanes of this one plan (`preview-gateway-recovery`); the
  verdict and `final_plan_hash` of its session cover every lane, exactly as one CI convergence normally allocates
  every lane of a plan. The covering run is PLAN-SPAR on the `plan(preview-gateway-recovery)` PR through the recovered
  preview, after both lanes are on `main` (the preview needs `runtime-profile`; PLAN-SPAR needs `plan-spar-token`).
  Its run link and `sparring/verdict.md` are attached to both ledger records by the owner (a canonical-ledger write).
  The #5117 emoji run is a separate verification and covers neither VTID.
- **Clock order:** steps 1–4 (roles, secrets, restore, proxy rev 21) need no VTID and run first. The owner allocates the
  two VTIDs only when the operator and reviewer are available for steps 5–7 and the covering sparring in the same day.

## 8. Unchanged
`vitana-gateway`, `vitana-gateway-awsdr`, rule 31 and every other listener rule, `PLAN_SPAR_GATEWAY_URL`, the staging
frontend, STAGING-VERIFY targets, PUBLISH. The 2026-11-17 reason stays unconfirmed (`artifacts/2026-11-17-scale-down-record.md`).

## Lanes (path-free in this plan PR; authoritative paths here)
- `runtime-profile` — adopt #5110: `services/gateway/src/**`, `services/gateway/test/runtime/**`, its workflow lines.
- `preview-ops` — `scripts/aws/preview-gateway/**` (the artifacts and the rehearsal), `docs/validation/<VTID>/**`.
- `plan-spar-token` — `.github/workflows/PLAN-SPAR.yml` (protected), depends on `preview-ops`.
- `incident-record` — `docs/ops/2026-11-17-preview-gateway-scale-down.md`.
<!-- plan:end -->
