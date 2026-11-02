# E. Modularisation assessment

The directive asks for logical modules with clear ownership, defined interfaces and controlled dependencies. It does not
ask for more services (§3.6). This section lists the module metadata that already exists, proposes module boundaries
from it, and shows which fields of a §4.1 manifest can be filled from existing sources.

## 1. Existing boundary metadata

| Artifact | Describes | Machine-readable | Kept in sync by | Use as a seed |
|---|---|---|---|---|
| `GW/orb/developer/domain-atlas.ts` (`DOMAIN_ATLAS`, VTID-04562) | 15 domains: key, title, summary, route-file regexes, code globs, core tables, flags, docs, aliases | TS array. `scripts/dev/context.mjs` regex-parses it (`parseAtlas`, `:89`), so its layout is a de-facto format. | `test/vtid-04560-role-separation-regression.test.ts:524-529`: every one of the 432 route files must be claimed (40 are claimed twice). `context.mjs check` warns on 8 dead code pointers. | **Primary seed for module keys** |
| `scripts/dev/context.mjs` | `route`, `screen`, `domain`, `vtid`, `why`, `uses` (import graph via `git grep`), `check` | `--json` | `scripts/dev/context.test.mjs` in `UNIT.yml` | Natural home for `module` and `graph` commands |
| `docs/programs/areas.yaml` (VTID-05145) | 4 seats → 4 areas (backoffice, messenger, platform, frontend) as path globs | YAML | read by `scripts/collab/queue.mjs` for the lane-scope check | **The only machine-readable ownership.** `GW/orb/**`, `lib/`, `middleware/`, `frontend/`, every non-gateway service, `.github`, and V1 `apps/mobile`, `packages/`, `supabase/` match no area. |
| `docs/programs/*/program.md` (10 programmes) | Programme front matter: status, priority, repos, exit criteria | YAML front matter | — | Module → programme link |
| `V1:src/design/screen-manifest.json` (VTID-05107) | 340 routes, each with archetype, tier, **area** (18 areas), status, phase | JSON | `screen-manifest.test.ts:20-62`: every `App.tsx` route exactly once | **Frontend module seed** (`area` → module) |
| `V1:src/navigation/registry/screens.json` | 184 voice-navigable screens: id, route, category, access, i18n, aliases. No role or tenant field. | JSON | `registry.routes.test.ts`, `build-nav-registry.test.ts`; gateway snapshot via `REGEN-SCREENS-CATALOG.yml` | Screen ids for working context (C §5) |
| `V1:apps/mobile/parity/ledger.json` (VTID-05157) | 435 web → native rows with lane, status, owner (set on 30 rows) | JSON | `parity-ledger.mjs` in `NATIVE-CI` | Native coverage per module |
| `V1:packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` | The files and assets that `@vitana/core` reaches; CI path filter | JSON, generated, `--check` in CI | `NATIVE-CI` | **Template for generated dependency edges** |
| `GW/governance/route-guard.ts` | Runtime route → owner (the `owner` string of each `mountRouterSync`); duplicate-route rejection | runtime map (`getRegisteredRoutes`, `:325`) | boot-time | Public API surface per module |
| `GW/services/tool-manifest.json` | 686 tools: surface, category, role, status, `wired_in` | JSON | — | Capabilities per module |
| `GW/services/automation-registry.ts` | 150 AP automations | TS | — | Automations per module |
| `.github/workflows/TEST-CATALOG.yml` (VTID-04637) | Every test in both repos; served at `GET /api/v1/testing/catalog` | generated | workflow | **Tests per module, once a module key is added** |
| `GW/constants/service-health-registry.ts` (`SERVICE_HEALTH_GROUPS`, `:41-83`) | Health checks grouped for `/api/v1/admin/health/summary` | TS | — | Health checks per module |
| `GW/specs/loop-catalog-v1.json` | 14 loops, owned sensors, actuators | JSON, loaded and validated by `GW/services/loop-catalog.ts` | `test/loop-catalog.test.ts` | Sensors per module. **Pattern to copy:** catalog JSON + loader + test + read-only route. |
| `agents_registry` v2 cards | skills, domains, `roles_allowed`, `surfaces_allowed`, owner, `eval_suite` | DB table | heartbeat | Agents per module |
| `P:config/service-path-map.json`; `services/**/manifest.json` (9) | Service → paths → deployable; service runtime | JSON | existence check only | Stale (A §9) |
| `.repowise/decisions.yaml` | 3 + 2 code-intel decisions | YAML | — | none |
| CODEINTEL-INDEX | `s3://vitana-code-index/{owner}/{repo}/{sha}/graph-index.json.gz`, `risk-index.json.gz` on every push to main | JSON in S3 | `CODEINTEL-INDEX.yml` | File-level import graph and risk |

## 2. Candidate modules

These are the 15 atlas domains, plus five areas the atlas does not cover: messenger, navigation, native-app,
edge-functions and platform-core. Tenancy class follows MT plan §4.3 vocabulary.

| Module | Main paths (P; V1) | Core tables | Tenancy class | Tests | Health | Owner today | Main gaps |
|---|---|---|---|---|---|---|---|
| voice | `orb-*`, `voice-*`, `live*`, `conversation*` routes; `GW/orb/**`; `agents/orb-agent`; V1 widget hooks | `oasis_events orb.live.*`, `voice_session_facts`, `ai_personality_config` | mixed (member brain per tenant + user; work surfaces) | `test/orb` (228 files), `test:flow`, `test:voice-identity` | ops/health orb-bootstrap-latency, orb-session-ledger; orb-agent `/alive` | none (`orb/**` matches no area) | no owner, no contract; 19k-line hub |
| autopilot (dev) | `dev-autopilot*`, `autopilot*`, `self-healing`, `execute` routes; executor image | `autopilot_recommendations`, `dev_autopilot_*`, `self_healing_log` | platform | only in the full Jest run | autopilot `/health` | `exafy` (platform catch-all) | no isolated suite |
| agents / operator | `operator*`, `orchestrator`, `worker-orchestrator`, `agents-registry`; `kiro-runner`; `agents/vitana-orchestrator` | `operator_threads`, `agent_runs`, `agents_registry` | platform | `test:operator` | kiro-runner `/alive`, heartbeat | `exafy` | kiro-runner and the verification engine are not in the atlas |
| oasis / governance | `oasis-*`, `vtid*`, `governance*`, `events`, `ops-*`; `oasis-projector`, `oasis-operator` | `vtid_ledger`, `oasis_events`, `system_controls` | platform (no tenant column) | ops-health-checks tests, projector Jest | ops/health vtid-ledger; projector `/ready` | `exafy` | event schema exists only as a TS union |
| deploy | `cicd`, `command-hub*`; `GW/frontend/command-hub`; `.github` | `oasis_events deploy.*` | platform | `test/command-hub` (47) | build-info, STAGING-VERIFY | none for `frontend/` | stale service-path-map |
| llm | `llm*` routes, `llm-router.ts`, `providers/bedrock.ts` | `llm_routing_policy` | platform | `test/providers` (3) | routines llm-fallback-watch, llm-spend-budget | `exafy` | thin tests |
| memory | `memory*` and awareness routes; V1 memory pages | `memory_items`, `memory_facts`, `relationship_*` | user-private, tenant-partitioned (C §4) | `test:memory` | admin-aurora-memory-health | `exafy` / `exafyltd` | atlas `/^me/` collision; dead pointer |
| community | `community*`, `notifications`, `automations`, `news-feed`, `media-hub`; V1 community and profile | `profiles`, `profile_posts`, `user_notifications` | tenant-shared, being isolated (WS3) | `test:community-autopilot`, `test:companion` | ops/health push-dispatch | `exafy` / `exafyltd` | V1 migrations still own some tables |
| messenger | `chat*`, `services/chat`; V1 messages | `chat_messages`, `chat_group_members` | participant-based; scope planned (mt-network) | none dedicated | none | `exafyltd` (areas.yaml) | not an atlas domain |
| support | `feedback*`, `specialists-*`, email-intake worker | `feedback_tickets` | tenant routing planned (VTID-05325) | `test:support` (rule 42c) | feedback `/health` | `exafy` | active MT lane |
| health | `health*`, `vitana-index`, `diary`, `reminders`, `journey-*`, `calendar*`; V1 health, calendar, journey | `vitana_index_scores`, `lab_reports`, `diary_entries` | user-owned; frozen health home tenant planned | `test:calendar` + `CALENDAR-REGRESSION.yml` (both repos) | calendar, diary `/health` | `exafy` / `exafyltd` | spans two databases; active Health programme |
| commerce | `offers`, `shop-*`, `discover-*`, `partner-*`, `vcaop*`, `vaea`; V1 discover, business | `merchants`, `products`, `partner_organizations` | global suppliers, tenant gating planned (WS11) | vcaop Jest | catalog-ingest `/health`, VCAOP-HEALTH | `exafy` / `exafyltd` | vaea and vcaop-mcp have no CI |
| payments | `wallet*`, `billing*`, `stripe-*`, `rewards*`; 6 V1 stripe edge functions | `wallet_accounts`, `wallet_transactions`, `subscriptions` | platform economy (D2) | none named | not mapped | `exafy` | dead atlas pointers, no docs |
| admin / tenancy | `admin-*`, `tenant-admin/*`, `me`, `auth`, `user-*`; `services/tenancy`; V1 admin (107 pages) | `app_users`, `tenants`, `user_tenants`, `role_preferences` | tenant + platform | `test:roles` | auth `/health` | `exafy` / `exafyltd` | catch-all regexes; **owned by the MT programme** |
| backoffice | `backoffice-*`, `erp-bridge`; V1 backoffice | `erp_commands`, `erp_approvals`, `erp_audit` | per tenant | erp-bridge pytest (not in TEST-SUITE) | erp-bridge `/alive`, `/ready` | `jtadic` | staging only |
| infra / data | `admin-health`, `aws-*`, postgrest proxy, realtime-aurora, migrations; V1 `integrations/supabase` | `system_controls` | platform | `UNIT.yml`, `MIGRATION-DRIFT-CHECK` | admin/health, `ci_vital_systems_health` | `exafy` | proxy and realtime missing from the atlas and the service table |
| navigation | `GW/navigation`, `test/nav-golden`; V1 `src/navigation/registry` | — | platform (no tenant field) | registry tests, `test:nav-redirect` | screen-load-health | `exafyltd` | not an atlas domain |
| native-app | V1 `apps/mobile`, `packages/core`, `packages/tokens` | — | platform shell; tenant-aware planned (WS9) | mobile Jest, `NATIVE-CI` | `MOBILE-DEVICE-E2E` | none | no deploy workflow; 405 of 435 ledger rows have no owner |
| edge-functions | V1 `supabase/functions` (65) | various | mixed | edge-data-client test only | none | none | not in the atlas |
| platform-core | `GW/lib`, `middleware`, `i18n`, `governance/route-guard.ts`, `oasis-event-service`, `notification-service`, `feature-flags` | — | cross-cutting | spread across suites | `/alive`, `/health` (static) | none | not a module anywhere |

## 3. Shared services without an owner

Auth and tenant middleware (193 importers), the Supabase client (292), OASIS (107), i18n, notifications, flags,
dependency probes and LLM routing (A §8) belong to no atlas domain and no area. Directive §4.3 contracts matter most
here, because every module depends on them. The MT programme owns the tenancy parts (B §8).

## 4. Dependency graph: what exists and what is missing

**Exists:**
- File-level import edges: `context.mjs uses`, and the CODEINTEL graph in S3 for every push to main.
- A generated closure for one consumer (`packages/core`).
- The route → owner runtime map.
- Atlas route claims.

**Missing:**
- Module-level edges (module A imports module B).
- Database edges: which module writes and which reads each table.
- Event edges: which module emits and which consumes each OASIS type.
- Cross-repo edges: V1 page → gateway route.
- Job and automation edges.

**Planned elsewhere:** mt-guardrails `generated-inventories` will produce table, function, route, edge-function, realtime
and bucket inventories with a byte-stable regeneration test (B §5). The module graph should join those inventories, not
re-derive them.

## 5. Missing contracts and metadata

Mapping of directive §4.1 manifest fields to what exists:

| §4.1 field | Existing source | Gap |
|---|---|---|
| id, name, description | atlas `key`, `title`, `summary` | 5 modules missing (§2) |
| business and technical ownership | areas.yaml seats (partial) | No business owner recorded anywhere. `orb/**` and non-gateway services have no technical owner. |
| repository and source paths | atlas regexes + globs; V1 screen-manifest `area` | V1 paths and other services not linked to the atlas |
| public APIs and interfaces | route-guard runtime map; atlas route claims; `P:specs/gateway-v1.yml` (7 paths, stale) | no contract documents |
| database ownership | atlas core tables | no write-ownership; tenancy classification planned in MT WS1/WS0 |
| events published and consumed | OASIS type prefixes; `CicdEventType` union | no consumer map |
| dependencies | import graph | no module-level edges |
| required permissions | route middleware (route-inventory test planned in mt-guardrails) | not recorded |
| tenant-awareness | MT §4.3 classes (planned), `TENANT_TABLES` (planned, mt-identity) | not recorded per module |
| supported roles | `ROLE_REGISTRY` tool packs; tool-manifest `role` | not per module |
| capabilities and agents | tool-manifest, `agents_registry` domains and skills, automation registry | no module key |
| flags and configuration | atlas flags, conversation flag registry, `system_controls` | partial |
| health checks and sensors | `SERVICE_HEALTH_GROUPS`; `/api/v1/ops/health/*`; loop-catalog sensors | no module key; `/health` and `/alive` are static (F §6) |
| test suites | TEST-CATALOG; named suites | no module key; no per-module CI selection |
| deployment and rollback boundaries | per-service workflows; VTID-04647 rollback | the gateway is one deploy unit (correct; do not split) |
| permitted autonomous actions | global self-healing autonomy level; injector scope `services/gateway/src/**` | not per module |

## 6. Opportunities for independent development

- **Separately deployed services already exist:** orb-agent, the verification engine, oasis-projector and
  oasis-operator, kiro-runner, erp-bridge, realtime-aurora, the PostgREST proxy. They need module entries and owners,
  not restructuring.
- **The gateway should stay one deploy unit.** Independence inside it means three things:
  - an owner per module;
  - tests selected by module;
  - interfaces through existing seams: the 420 `*-repository.ts` files and the route mounts.
- **Modules with their own suites today:**
  - `test:support`, `test:operator`, `test:roles`, `test:memory`, `test:calendar`, `test:community-autopilot`.
  - `test:flow` and `test:replay` (conversation).
  - `test:onboarding`, `test:nav-redirect`, `test:voice-identity`, `test:screens-catalog-sync`.
  - All of them run inside the full `TEST-SUITE` shards. Only calendar has a dedicated CI job (`CALENDAR-REGRESSION.yml`).
- **Lowest MT overlap**, which makes these good pilot candidates for module-aware healing (G, IA-6):
  - llm: platform-wide, with sensors in L5 routines.
  - calendar: suites in both repos, a dedicated CI job, a health route.
  - deploy: platform-wide.
  - Support, messenger, community, health, commerce and admin/tenancy all have active MT or Health lanes and should
    adopt later.

## 7. Recommendation for the Module Registry (input to G, IA-2)

Follow the loop-catalog pattern that already exists, rather than inventing a new one:

1. **Catalog.** `P:services/gateway/specs/module-catalog-v1.json`, keyed by atlas `key`, adds the §4.1 fields in §5.
   - Owner is taken from areas.yaml. Missing business owners are marked `unassigned` explicitly.
   - Tenancy class and roles come from `ROLE_REGISTRY` tool packs.
   - V1 areas come from screen-manifest.
   - Tests come from a TEST-CATALOG module key.
   - Health comes from `SERVICE_HEALTH_GROUPS`.
   - Sensors come from the loop catalog.
2. **Loader and validator.** `GW/services/module-catalog.ts` mirrors `loop-catalog.ts`. Every route file, top-level
   service file and V1 screen-manifest area maps to exactly one primary module. Every referenced path, test, table and
   flag must exist.
3. **Atlas unchanged for the developer ORB.** Fix the `/^me/` collision and the 8 dead pointers. Add the five missing
   domains so atlas keys equal module keys.
4. **Generated graph.** `module-graph.generated.json` is built by a script in the style of `core-closure.mjs`: import
   edges grouped by module, table read/write edges from repository files, route mounts. CI runs it with `--check`.
   - It joins mt-guardrails inventories when they land.
   - Until then the database and route sections are marked `pending: mt-guardrails`.
5. **Commands.** `context.mjs module <key>` and `context.mjs graph <key> --impact` for impact analysis (directive §4.2).
6. **Not done:**
   - no code moves;
   - no new service;
   - no runtime behaviour change;
   - no table, route or function inventory that mt-guardrails will generate;
   - no hand-written contract documents until a module is adopted (directive WS7).
