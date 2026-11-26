# Registration blocked: PLAN-SPAR is refused by the gateway it calls

Kiro 3, session `kiro-exafyltd-202611181014-b8e5`, 2026-11-19. Everything below was read without writing anything and without reading any
secret value: workflow and code text, GitHub run logs, and AWS metadata (task definitions, listener rules, secret names and change dates).

## The contract, end to end
| Step | Where | What must hold |
|---|---|---|
| 1. Token and URL | `.github/workflows/PLAN-SPAR.yml:92-93` | `GATEWAY_URL` = `vars.PLAN_SPAR_GATEWAY_URL` or `https://preview-aws-gateway.vitanaland.com`; `GATEWAY_SERVICE_TOKEN` = the repository secret of that name. |
| 2. Request | `scripts/collab/plan-spar.mjs:140,165` | `POST /api/v1/plans/spar` with `Authorization: Bearer <token>` (then `/:id/rounds`, `GET /:id`, and `POST /api/v1/vtid/allocate` when `PLAN_SPAR_ALLOCATE=true`, `:186`). |
| 3. Routing | ALB `vitana-alb-prod`, listener 443 | Rule 9: host `preview-aws-gateway.vitanaland.com` and path `/api/v1/*` → target group `vitana-tg-gateway-preview` → ECS service `vitana-gateway-preview`. (Rule 10, `/api/*` on any host → `vitana-tg-gateway-prod`, the staging gateway service `vitana-gateway`, no longer sees these paths.) |
| 4. Check | `services/gateway/src/routes/plans-spar.ts:46,56,66` → `middleware/require-service-or-admin.ts:71-104` | The bearer must equal the serving task's `GATEWAY_SERVICE_TOKEN` env exactly (`matchesServiceToken`, `:53-56`: non-empty and `===`); otherwise it must be a JWT that `optionalAuth` verifies and that carries `exafy_admin` (`:89-103`). Neither → 401 `unauthorized — service token or exafy_admin JWT required` (`:101`). |

## What is wrong (measured 2026-11-19)
- The task serving step 3, `vitana-gateway-preview:2` (registered 2026-11-18T22:23:18Z by the SSO identity `d.stevanovic@vitanaland.com`,
  primary deployment 22:23:31Z), has **no `GATEWAY_SERVICE_TOKEN`**. Its secrets are `DEEPSEEK_API_KEY`, `GATEWAY_INTERNAL_TOKEN`,
  `PLAN_SPARRING_GITHUB_TOKEN`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` (← `vitana/gateway/staging/postgrest-jwt-secret`) and
  `SUPABASE_SERVICE_ROLE` (← `vitana/gateway/staging/postgrest-service-role-key`). So `matchesServiceToken` is false for every token.
- PLAN-SPAR's token then reaches the JWT path, where the preview verifies with the staging PostgREST JWT secret. The token PLAN-SPAR
  holds is what the production and former staging tasks use as `GATEWAY_SERVICE_TOKEN` (← `vitana/supabase/prod/service-role-key`), so it
  cannot verify there, and the answer is the observed 401. This matches the preview-gateway-recovery plan (#5122, plan.md:34).
- Every PLAN-SPAR run since then failed (latest: run 44539300055, 2026-11-19 14:01, `plan-spar: create: HTTP 401 …`). The last successes
  were on 2026-11-15 07:31 to 07:36, through the staging gateway, which has been scaled to 0 since (`vitana-gateway`: desired 0, running 0).
- The preview runs with `VTID_ALLOCATOR_ENABLED=false` and `SUPABASE_URL=http://postgrest-aurora.vitana.internal:8080` (the isolated staging
  Aurora). Fixing the token there resumes **sparring**, but a VTID allocated through the preview would be off (allocator disabled) or land
  in the isolated ledger, not the canonical one. **Registration (VTIDs) needs a canonical allocator path as well.**
- The other 18 workflows that send the same repository secret (production health and alert jobs, VTID-ALLOCATE, VTID-AUTO-CLOSE) still
  work with it, so **the repository secret must not be changed**.
- The staging deploy now wires `GATEWAY_SERVICE_TOKEN` from `vitana/gateway/staging/service-token` (`AWS-STAGE-DEPLOY-GATEWAY.yml:1121`,
  commit `fca0186b32`, 2026-11-18). No secret of that name exists in `eu-central-1` (the `vitana/gateway/staging/*` list has 15 names, not
  that one), so a staging redeploy would fail closed (the workflow's own rule).
- `vitana/gateway/staging/preview-sparring-token` exists (created 2026-11-18T15:23:09Z), the token the recovery plan intended for the
  preview, but no task definition references it.

## Approved alternative to PLAN-SPAR for this plan
None. A Kiro plan is sparred only by CI PLAN-SPAR (`.kiro/steering/vitana-kiro-notes.md`); the local sparring partner is a Claude Code
path (skill `plan-sparring`); break-glass allocation (CLAUDE.md rule 55) is the owner's alone and needs the gateway or Bedrock down;
VTID-ALLOCATE uses the same secret and URL and is for Claude Code sessions. Kiro may not allocate by hand (§7a). So this plan waits.

## Minimal fix for an authorized admin (no value is shown in any command; none is printed)
This is the preview-gateway-recovery plan's D1, to be applied under the owner's Rule 55 ruling on #5122, not a second design.
1. Bind the preview token on the preview gateway: register `vitana-gateway-preview:3` = `:2` plus the secret
   `{name: GATEWAY_SERVICE_TOKEN, valueFrom: <ARN of vitana/gateway/staging/preview-sparring-token>}`, give the preview task's execution
   role `secretsmanager:GetSecretValue` on that ARN, and update service `vitana-gateway-preview` to `:3`.
2. Give PLAN-SPAR that token without touching the shared secret: a new repository secret, set from the store without printing it,
   `aws secretsmanager get-secret-value --region eu-central-1 --secret-id vitana/gateway/staging/preview-sparring-token --query SecretString --output text | gh secret set PLAN_SPAR_GATEWAY_TOKEN --repo exafyltd/vitana-platform`,
   and in `.github/workflows/PLAN-SPAR.yml:93` `GATEWAY_SERVICE_TOKEN: ${{ secrets.PLAN_SPAR_GATEWAY_TOKEN || secrets.GATEWAY_SERVICE_TOKEN }}`.
   PLAN-SPAR.yml is a protected gate file (`collaboration.md` §3a): it needs the owner's instruction naming the plan plus a
   reviewer-agent accept on the current head.
3. Keep allocation off while the preview is the target (`PLAN_SPAR_ALLOCATE=false` for these runs), as the recovery plan's D2 says.
4. For VTIDs: either restore a canonical allocator path (create `vitana/gateway/staging/service-token`, redeploy and scale the staging
   gateway, route `/api/v1/vtid/allocate` to it) or the owner allocates under rule 55. Which ledger is canonical during the Aurora cutover
   (VTID-05803) is the owner's decision.

Read-only check afterwards (the admin, with the token in a variable and never echoed):
`curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" https://preview-aws-gateway.vitanaland.com/api/v1/plans/spar/00000000-0000-0000-0000-000000000000`
must print 404 (authenticated, no such session), not 401; without the header it prints 401. Then re-run the newest PLAN-SPAR run of this PR.

## VTID mapping (nothing allocated by hand)
| Work | Commits | Plan / lane | VTID |
|---|---|---|---|
| PM retry schedule | `8633cb4691` | agentic-delivery-scope / dispatcher | VTID-05737 (allocated 2026-11-11) |
| PM retry decision | `43e5e4f3c5`, `e094e26718` | agentic-delivery-scope / dispatcher-pm | VTID-05736 (allocated); the commit edits 4 files outside the lane's paths, so it needs that plan's driver to widen the paths or split it |
| durable events, issue facts | `ad1b7b35f6` | delivery-loop-engine / durable-events | pending: CI PLAN-SPAR (blocked) |
| client, fingerprint, controls, engine, rehearsal fixes | `8f95b0e6cc`, `b9ea03d9d8`, `2dd21218a2` (engine part), `c941677039` | delivery-loop-engine / loop-engine | pending (blocked) |
| rehearsal scripts | `2dd21218a2` (scripts part) | delivery-loop-engine / loop-rehearsal | pending (blocked) |
| GitLab-native executor, bridge guards | slice 8 on `kiro/delivery-loop-engine/gitlab-executor` | delivery-loop-engine / gitlab-executor | pending (blocked) |
| adapters, runtime, status route, wiring | `edaff12f2c` + the slice 8 binding | delivery-loop-engine / loop-runtime | pending (blocked) |
