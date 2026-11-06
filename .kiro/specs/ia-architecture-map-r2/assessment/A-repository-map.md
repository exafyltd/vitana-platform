# A. Current-state repository map

Baseline: `vitana-platform` `62990ce285` and `vitana-v1` `58c76c956`, both 2026-11-01. Counts come from `git ls-files`,
`wc` and `grep` on this checkout. Paths use `P:`, `V1:` and `GW` (`P:services/gateway/src`).

## 1. Size and shape

| Area | Size | Notes |
|---|---|---|
| Gateway (`P:services/gateway`) | about 582k lines of TypeScript in 3,782 `.ts` files | One Express service. It hosts the API, ORB voice, the Operator Console, Dev Autopilot, OASIS routes and the Command Hub UI. |
| Gateway route files | 432 non-test files: 298 handler files and 134 `*-repository.ts` data seams | Every file is claimed by a `DOMAIN_ATLAS` domain (drift test, see E §1) |
| Gateway mount table | `GW/index.ts` (2,395 lines): 301 `mountRouterSync` calls on 223 prefixes | `governance/route-guard.ts` rejects duplicate routes and keeps a runtime route → owner map (`getRegisteredRoutes`, `:325`) |
| Web app (`V1:src`) | about 392k lines in 3,748 files; 396 page `.tsx` (107 admin, 46 dev, 30 backoffice) | Vite SPA, AWS-hosted |
| Mobile (`V1:apps/mobile`) | about 18k lines; Expo 57 / React Native 0.86 | `NATIVE-CI.yml` only. No store or EAS deploy workflow. |
| Migrations | `P:supabase/migrations` 674, `V1:supabase/migrations` 391 | Both repos write the same Supabase project. No rule assigns tables to a repo (A §4). |
| Edge functions | `V1:supabase/functions`: 65 plus `_shared` | Deployed by `supabase-functions-deploy.yml`, which is behind `cutover_gate` |

## 2. Services (`P:services/*`)

| Service | Purpose | Language | Deploy | Live |
|---|---|---|---|---|
| `gateway` | API, ORB, Operator, Autopilot, OASIS, Command Hub | TS | `AWS-STAGE-DEPLOY-GATEWAY.yml` on push to main; `AWS-PROD-DEPLOY-GATEWAY.yml` by PUBLISH or pinned dispatch | prod |
| gateway, autopilot-executor image | Dev Autopilot agent loop as an ECS RunTask | TS | `AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml` (dispatch only) | prod |
| `agents/orb-agent` | LiveKit voice worker (about 12k Python lines; the README still says "Skeleton") | Python | `AWS-PROD-DEPLOY-ORB-AGENT.yml` | prod |
| `agents/vitana-orchestrator` | Verification engine (VTID-01175). The worker orchestrator calls it; Dev Autopilot does not. | Python | `AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml` | prod |
| `oasis-operator` | OASIS operator API | Python | `AWS-PROD-DEPLOY-OASIS-OPERATOR.yml` | prod |
| `oasis-projector` | Event projector / ledger writer (Prisma) | TS | `AWS-PROD-DEPLOY-OASIS-PROJECTOR.yml` | prod |
| `kiro-runner` | Runs `kiro-cli acp` per Operator session (VTID-04999) | TS | stage and prod workflows | prod state not in the infrastructure.md table [unverified] |
| `erp-bridge` | Allowlisted facade over ERPClaw (VTID-03840) | Python | `AWS-STAGE-DEPLOY-ERP-BRIDGE.yml` | staging |
| `postgrest-aurora-proxy` | PostgREST in front of Aurora | nginx/SQL | stage and prod workflows | staging [doc] |
| `realtime-aurora` | Self-hosted Supabase Realtime on Aurora (VTID-05023) | image | `AWS-PROD-DEPLOY-REALTIME-AURORA.yml` | switched by repo variable `VITE_REALTIME_URL_*` [unverified] |
| `vcaop` | Commerce and account-ops control plane, "never production" (`P:vcaop/CURRENT-STATE.md`) | TS | `VCAOP-CICD`, `VCAOP-HEALTH` (CI only) | dev/staging |
| `vcaop-mcp` | Public MCP/OAuth gateway (VTID-03533), blocked on BLK-006/007 | TS | none | no |
| `mcp-gateway`, `mcp` | Older developer MCP aggregator; `mcp` is a 2025 stub | TS | none (`MCP-GATEWAY-CI.yml`, cited in `infrastructure.md:308`, does not exist) | dormant |
| `vaea` | Business Hub economic actor, observe mode (VTID-02401) | TS | none | no |
| `openclaw-bridge` | OpenClaw skills to OASIS | TS | TEST-SUITE only | no |
| `validators` | Frontend canonical-source check | JS | `ENFORCE-FRONTEND-CANONICAL-SOURCE.yml` | CI tool |

`P:packages/*`:
- `llm-router` (Python, 2025) is superseded by `GW/services/llm-router.ts`.
- `openapi` contains only a README. The real specs are `P:specs/gateway-v1.yml` with 7 paths and `oasis-v1.yml`.
- `py` and `agent-heartbeat.ts` date from 2025.

All four are legacy.

## 3. Other top-level directories

| Directory | State |
|---|---|
| `P:routines/` | Active. 19 routine specs run by the gateway routine runner (VTID-05103). |
| `P:cloudflare/` | Active. 4 Workers; only `vitanaland-og-proxy` is deployed. |
| `P:infra/` | Reference Terraform (Cognito migration, LiveKit). The real infrastructure code lives in a separate private repo [doc]. |
| `P:prisma/` | Used by `oasis-projector` only. |
| `P:kb/`, `P:integrations/` | Low activity |
| `P:database/`, `P:gov/`, `P:phase_2b/`, `P:crew_template/`, `P:skills/`, `P:tasks/`, `P:specs/`, `P:mcp/` | Legacy |
| `P:second-brain/` | Frozen history. `docs/CONTEXT-MAP.md` says it is not a source of truth. |
| `V1:packages/core` | `@vitana/core` re-export layer for mobile (VTID-05183). Its `closure.generated.json` is the only dependency-closure artifact in either repo. |
| `V1:packages/tokens` | Design tokens |

## 4. Data platform

- **One Supabase project serves production.** Staging and preview frontends write to it too (CLAUDE.md rule 31).
- **The Aurora migration is in progress.**
  - Programme: `docs/programs/aurora-cutover`.
  - Repo variable `MIGRATION_TARGET`, where unset means `supabase`.
  - `.claude/rules/backend.md` (2026-08-18) says "do not assume Aurora is primary": about 231 gateway files use
    `SUPABASE_URL` and 2 use `AURORA_DATABASE_URL` [doc].
- **Migration ownership is implicit.**
  - In practice new schema lands in `P:supabase/migrations` (198 files after 2026-08-01, against 18 in V1).
  - V1 still owns some social tables. `DATABASE_SCHEMA.md` cites V1 migrations at `:173`, `:2154`, `:3847`.
  - `MIGRATION-DRIFT-CHECK.yml` scans only platform migrations and checks that tables exist, not that versions match.
- **Seams that exist today.** 420 `*-repository.ts` files isolate data access. This is the main lever for later
  module-level data ownership.

## 5. Events and schedules

| Mechanism | Where | Notes |
|---|---|---|
| OASIS events | `emitOasisEvent` (`GW/services/oasis-event-service.ts:59`) writes `oasis_events` | 107 importers. There are 710 distinct literal `type` strings under 92 prefixes. The union type `CicdEventType` (`GW/types/cicd.ts:139`, 647 members) is enforced by an impact rule. Some prefixes (accounting, crm, finance) are probably ERP command names [unverified]. |
| EventBridge schedules | `P:scripts/aws/setup-eventbridge-*.sh` (4 scripts) | `setup-eventbridge-cron-migration.sh` pins one tenant per job (`:156-161`). The fix is lane `jobs-env-prepare` (VTID-05269, not started). |
| Gateway in-process loops | heartbeat (`GW/index.ts:1841-1866`), self-healing reconciler (`:2146`), Dev Autopilot ticks (`:2251-2267`), routine runner | — |
| Realtime | `V1:src/integrations/supabase/realtime.ts` (`realtimeChannel`, 61 call sites in 40 files) | Enforced by `scripts/check-realtime-helper.mjs` |

## 6. Delivery pipeline

- Merging to `main` deploys to staging only.
- After that deploy, `STAGING-VERIFY.yml` runs the smoke suites plus each change's `docs/validation/<VTID>/staging-tests.json`.
- Production moves only by PUBLISH, or by a pinned dispatch commanded by the owner (CLAUDE.md rules 46-50a).
- PR gates:
  - Platform `PR-GATE.yml`: title, scope, sparring, test-weakening, red→green, collab-handoff and lane-scope checks.
  - Platform `TEST-SUITE.yml`: gateway Jest in 4 shards.
  - V1: `PR-GATE`, `UNIT-TESTS` and `NATIVE-CI`.
- **Tests cannot be selected per domain today.** Any `services/**` change runs the whole gateway suite. The only
  dependency-derived selection is the `NATIVE-CI` `changes` job, which uses `scripts/native/mobile-ci-paths.generated.json`.

## 7. Hot files

These files are large, edited by many plans, or both. Section B §7 lists which MT plans claim them.

| File | Lines |
|---|---|
| `GW/frontend/command-hub/app.js` | 49,393 |
| `GW/routes/orb-live.ts` | 19,278 |
| `GW/services/gemini-operator.ts` | 6,213 |
| `GW/services/orb-tools-shared.ts` | 5,666 |
| `GW/services/dev-autopilot-execute.ts` | 4,543 |
| `GW/orb/live/session/live-session-controller.ts` | 3,362 |
| `GW/orb/live/session/upstream-message-handler.ts` | 3,066 |
| `GW/orb/live/tools/live-tool-catalog.ts` | 2,935 |
| `GW/index.ts` | 2,395 |
| `V1:src/App.tsx` | hot-file rule (collaboration.md §8a.4) |

## 8. Cross-cutting gateway modules

None of these is owned by an atlas domain (E §3).

| Concern | Module | Importers |
|---|---|---|
| Supabase client | `GW/lib/supabase.ts` `getSupabase` | 292 |
| Auth and tenant middleware | `GW/middleware/auth-supabase-jwt.ts` | 193 |
| OASIS | `GW/services/oasis-event-service.ts` | 107 |
| i18n | `GW/i18n/catalog.ts`, `server-locale.ts` | 39 / 36 |
| Notifications | `GW/services/notification-service.ts` | 18 |
| Dependency probes | `dependency-probe.ts` | 18 |
| Tenancy | `GW/services/tenancy/tenant-context.ts` | 10 |
| Flags | `GW/services/feature-flags.ts` (`isFeatureLive`), `mt-flags.ts`, `native-push-flags.ts`, `system-controls-service.ts` (DB `system_controls`) | — |
| LLM routing | `GW/services/llm-router.ts`, `GW/providers/bedrock.ts` | — |

## 9. Stale documentation

Each of these could mislead a planner.

| Document | Problem |
|---|---|
| `.claude/rules/infrastructure.md:59`, `:135` | Still describes worker-runner. It was retired in commit `9dec0c4399` (VTID-04327). |
| `P:config/service-path-map.json` | 12 entries with a GCP field. It lacks realtime-aurora, postgrest-aurora-proxy, vcaop, vcaop-mcp and orb-agent. `GW/routes/cicd.ts:112` still reads it. |
| `services/**/manifest.json` (9 files) | Stale. The gateway's still names Prisma and `DATABASE_URL`. CI checks only that the files exist. |
| `docs/ORCHESTRATOR-REDESIGN-PLAN.md:3` | Says "nothing built yet". Phases P1, P3 and P4 are partly built (D §7). |
| `GW/orb/live/upstream/upstream-provider-selector.ts:1-64` | Header still describes Vertex as the default. |
| `DATABASE_SCHEMA.md` | Header says "Last Updated: 2025-11-11". |
| `V1:docs/ROLE_SCREEN_MATRIX.md`, `TENANT_SCREEN_AVAILABILITY.md`, `SCREEN_REGISTRY.md`, `API_INVENTORY.md` | Prose. 2024-2025 snapshots, not kept in sync. |
| `.claude/CLAUDE.md` RepoWise block | Indexed 2026-09-19: 894 commits behind HEAD in platform, 464 in V1 |
