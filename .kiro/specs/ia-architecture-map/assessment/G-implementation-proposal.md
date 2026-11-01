# G. Implementation proposal

A coordinated sequence for directive workstreams 1-7. It is written to go through the existing pipeline unchanged:
1. one `plan(<slug>)` PR per plan;
2. CI PLAN-SPAR;
3. policy approval (`converged-auto-v1`), or owner Gate 1 if a plan escalates;
4. CI allocates one VTID per lane;
5. lanes are built, accepted by the reviewer agent, and merged under §7b to staging;
6. STAGING-VERIFY;
7. Gate 2.

No VTID is allocated here. The IDs below (IA-1, IA-2a, …) are placeholders until PLAN-SPAR assigns real VTIDs.

## 1. Principles applied

- Extend what exists:
  - the atlas, the loop catalog pattern and TEST-CATALOG (E §7);
  - TenantContext and the existing role resolvers (C §10);
  - `agent_runs` and `dispatchOrbTool` (D §7);
  - the self-healing intake (F §3).
- Consume MT interfaces only through the stable list (B §8). Never edit the "about to change" files without the MT
  driver's agreement.
- Every code change is dark by default. IA flags use their own names, never `mt.*` or `MT_RESOLUTION_V2`.
- IA migrations use their own range, get a `MIGRATION-QUEUE.md` row, need owner approval to apply, and are never mixed
  with MT migrations.
- Hot files get changes of 20 lines or fewer in their own PR, rebased before merge (MT plan §8), with serialized landing
  (collaboration.md §8a).
- No test against production. Write paths are proven by unit and integration tests over in-memory stores. Staging suites
  are read-only (rules 47-48).

## 2. Phase 0: decisions before any IA code

| # | Decision | Owner | Blocks |
|---|---|---|---|
| 0.1 | Authorization gaps: done as Track S plan `mt-track-s-authz` (PR #4579, lanes `approvals-auth`, `work-surface-permission`) | — | IA-3, IA-4 |
| 0.2 | Escalated MT plans: superseded by the `-r2` re-plans of 2026-11-01 (B §0). `approve-11.sh` should not be run | — | — |
| 0.3 | Single role source: `mt-identity-r2` lane 4 picks `user_tenants.active_role`. Open: grants must stay separate from the selection, and role scope (platform vs tenant, C §2) | MT planner (`hotmail`), via `mt-identity-r2` sparring | IA-3 |
| 0.4 | Memory continuity across tenants under D8 (C §4): user-owned memory with a tenant-scoped social context, as D8 says, or keep tenant partitioning | Owner with the MT planner (and counsel if D20 applies) | any cross-tenant memory change (none is proposed before this) |
| 0.5 | A machine-producer sparring policy for self-healing and Dev Autopilot before the gate goes to `enforce` (F §8) | Owner | widening autonomy (none is proposed) |
| 0.6 | Planning seat for IA plans, and whether the MT planner seat `hotmail` co-authors IA-3. Optionally add an `orb` area to `areas.yaml` (today `GW/orb/**` has no area). | Owner | IA plan authoring |
| 0.7 | VCAOP healing: bridge into the central intake, or retire it (F §4) | Owner; commerce owners | IA-6f |

## 3. Sequence

```
Phase 0 decisions ──► IA-1 map ──► IA-2 registry ──────────────► IA-5 trace ──► IA-6 healing ──► IA-7 adoption
                         │              │                           ▲               ▲
  mt-track-s-authz ──────┼──────────────┼──► IA-3 contract ──► IA-4 ORB ─┘               │
  mt-identity-r2 ────────┼──────────────┘        ▲     ▲                                 │
  mt-guardrails-r2 (local stack, inventories) ───┘     │ (fixtures; IA-2d joins inventories)
  mt-packs-r2 persona-pack (hot ORB files) ────────────┘ (IA-4 sequenced after it)
  migration queue (Lane A) ──────────────────────────────────────────────────────────────┘ (IA-6b)
```

| Order | Plan (slug) | Directive WS | Touches MT files? | Can start when |
|---|---|---|---|---|
| 1 | IA-1 `ia-architecture-map` | WS0 deliverable → WS1 | no (docs only) | this assessment is reviewed |
| 2 | IA-2 `ia-module-registry` | WS2 | no | IA-1 plan approved (they can be sparred together) |
| 3 | IA-3 `ia-context-contract` | WS3 | no for 3a-3c; consumes stable interfaces only | `mt-track-s-authz` merged; `mt-identity-r2` approved |
| 4 | IA-4 `ia-orb-context` | WS4 | **yes**: hot ORB files shared with `mt-packs-r2` and `mt-network-r2` | IA-3 done; `mt-packs-r2` `persona-pack` merged |
| 5 | IA-5 `ia-execution-trace` | WS5 | `orb-tools-shared.ts` (shared with `mt-network-r2`, `mt-packs-r2` `kb-overlay-code`) | IA-2 and IA-3 done |
| 6 | IA-6 `ia-module-aware-healing` | WS6 | no MT files; one IA migration | IA-2 done; queue slot agreed with Lane A |
| 7 | IA-7 `ia-progressive-adoption` | WS7 | per module, after that module's MT lanes are done | IA-6 pilot verified |

**PLAN-SPAR capacity.** At most 2 sessions run repo-wide, and MT plans are queued. Submit one IA plan at a time. Do not
re-run IA sparring while MT re-plans are waiting.

## 4. Plans and lanes

Each lane gets one VTID from PLAN-SPAR. Sizes: S = 1 PR of 5 files or fewer; M = 1-2 PRs; L = 3 or more PRs.

### IA-1 `ia-architecture-map` (WS1), 1 lane, S

- **Objective.** Land the authoritative architecture map and gap analysis: these files, condensed, at
  `P:docs/architecture/INTEGRATED-ARCHITECTURE.md`, with every source link checked.
- **Lane `map-doc`.**
  - Paths: `docs/architecture/**`, and one row in `docs/CONTEXT-MAP.md`.
- **Out of scope.** Any code.
- **Acceptance:**
  - `node scripts/dev/context.mjs check` reports zero dead links in the new docs (extend `check` to cover `docs/architecture/`).
  - Reviewed by the MT planner seat for B-section accuracy.
- **Evidence.** The `check` output in `docs/validation/<VTID>/`. The PR deploys nothing, so there is no Gate 2.

### IA-2 `ia-module-registry` (WS2), 4 lanes, M

- **Objective.** A machine-readable module catalog and a generated module dependency graph that extend the atlas
  (E §7). No runtime behaviour change.

| Lane | Paths | Depends on | Acceptance |
|---|---|---|---|
| 2a `atlas-fixes` | `GW/orb/developer/domain-atlas.ts`, its test section | — | Fix the `/^me/` over-claim. Fix the 8 dead pointers. Add domains `messenger`, `navigation`, `native-app`, `edge-functions`, `platform-core`. The drift guard stays green. `test:roles` green. |
| 2b `module-catalog` | `GW/specs/module-catalog-v1.json`, `GW/services/module-catalog.ts`, `GW/test/module-catalog.test.ts` | 2a | Every route file and top-level service entry maps to exactly one primary module. Every path, test, table and flag reference resolves. Owner comes from `areas.yaml`, or is explicitly `unassigned`. The validator fails on a planted dead reference (red → green). |
| 2c `v1-module-areas` | `V1:src/design/module-areas.json`, its test | 2b (keys) | Each of the 18 screen-manifest areas maps to one module key. The test fails on an unmapped area. `screens.json` and `App.tsx` are untouched (hot files). |
| 2d `module-graph` | `P:scripts/dev/module-graph.mjs`, `P:scripts/dev/module-graph.generated.json`, `context.mjs` (`module`, `graph` commands), `scripts/dev/*.test.mjs` | 2b, 2c | Byte-stable regeneration (`--check` in `UNIT.yml`). `graph <key> --impact` lists dependent modules from import and table edges. Database and route inventories come from `mt-guardrails-r2` lane `generated-inventories` (VTID-05445, `scripts/mt/inventory/**`); until it lands they are marked `pending: mt-guardrails-r2`, then joined, not re-derived. |

**Security and tenancy.** None. Read-only metadata.

**Rollback.** Revert the PRs. Nothing reads the catalog at runtime yet.

### IA-3 `ia-context-contract` (WS3), 3 lanes, M

- **Objective.** One canonical, server-derived context shape covering identity, tenant, role (selected, scope,
  permitted), working context (surface, route, screen id, task) and permissions. It is built only from existing
  resolvers.
- **Out of scope:**
  - any new resolver, cache, claim, table or policy;
  - any change to the auth middleware, `tenant-context.ts` or the role tables;
  - wiring into live paths (that is IA-4).

| Lane | Paths | Depends on | Acceptance |
|---|---|---|---|
| 3a `contract-doc` | `docs/architecture/context-contract.md` | `mt-track-s-authz`, `mt-identity-r2` | Co-signed by the mt-identity planner, with the agreement recorded in the IA plan. Maps each field to its source of truth (C §1). States that working context never raises role or permissions. |
| 3b `context-builder` | `GW/services/context/vitana-context.ts`, its test | 3a | `buildVitanaContext()` composes `verifyAndExtractIdentity`, `getTenantContext`, `resolveEffectiveRole`/`fetchPermittedRoles`, `resolveAssistantProfile` and `ClientContextEnvelope`. A test asserts it imports no DB client directly. Flag `IA_CONTEXT_SNAPSHOT` (default off) emits a `context.resolved` telemetry event only. |
| 3c `context-scenarios` | `GW/test/ia-context-scenarios.test.ts` | 3b | The eight directive §9.2 scenarios over in-memory fixtures named like `mt-guardrails-r2`'s (T_A, T_B, a_member, a_admin, ab_dual, plus a platform developer). They become pgTAP cases once the local stack lands. |

The eight scenarios:
1. multiple roles in one tenant;
2. the same role in two tenants;
3. different roles across tenants;
4. a role switch;
5. a tenant switch with an active role;
6. a screen or task change;
7. a revoked permission;
8. a cross-role or cross-tenant attempt.

**Security and tenancy.** The core of the plan. Every scenario asserts the tenant comes from a membership-checked
source and the role is within the permitted set.

**Rollback.** Flag off, or revert.

### IA-4 `ia-orb-context` (WS4), 4 lanes, L

- **Objective.** Voice and text resolve context through the same builder. A mid-session surface change re-checks
  permission. `ROLE_REGISTRY.memoryScope` is enforced.
- **Out of scope:** cross-tenant memory (decision 0.4); persona and pack changes (`mt-packs-r2`); recipient scope (`mt-network-r2`).

| Lane | Paths | Depends on | Acceptance |
|---|---|---|---|
| 4a `text-path-context` | `GW/routes/conversation.ts` (20 lines or fewer), V1 `coach-chat-api.ts` | IA-3 | `/conversation/turn` takes the role from the builder (`mt-track-s-authz` already clamps a privileged body role). The real route and screen id replace the fixed `ui_context`. Contract test: the same user, tenant, role and screen give the same snapshot on voice and text. |
| 4b `voice-path-context` | `live-session-controller.ts`, `session-profile.ts` (20 lines or fewer each, own PRs) | IA-3; `mt-packs-r2` `persona-pack` merged | The session stores the builder's snapshot. `context_update` with a surface change re-validates; a non-permitted surface is refused. A revoked permission denies the next privileged tool call (test). |
| 4c `memory-scope` | `GW/services/orb-memory-bridge.ts` (+ repository) | 4b | Behind flag `IA_MEMORY_SCOPE_ENFORCE` (off): scope `none` reads no member memory; scope `developer` reads developer memory only. `test:memory` stays green. |
| 4d `one-resolution` | `GW/services/context/*`, call sites in 4a and 4b | 4a, 4b | One function produces the bootstrap context input for voice and text. Duplicate role and tenant lookups on those paths are removed (count before and after in the PR). |

**Required suites:** `test:roles`, `test:support`, `test:operator`, `test:voice-identity`, `test:nav-redirect`,
`test:memory`, the MT suites in B §9 rule 6, and the Maxina golden suite once `mt-guardrails-r2` lands it (VTID-05448).

**STAGING-VERIFY.** Read-only checks: `/api/v1/orb/live/transport`, ORB health, build-info commit.

### IA-5 `ia-execution-trace` (WS5), 3 lanes, M

- **Objective.** One member request traceable from the ORB turn to the tool call, the execution run and the
  verification, with user, tenant, role, surface, module, agent and run id.

| Lane | Paths | Depends on | Acceptance |
|---|---|---|---|
| 5a `trace-id` | `GW/services/orb-tools-shared.ts` (20 lines or fewer; sequenced with `mt-network-r2` and `mt-packs-r2`), `GW/services/context/*` | IA-3 | A `trace_id` is created per ORB turn and written to `oasis_events.metadata`, `agent_runs.metadata` and `automation_runs.metadata`. **No schema change.** |
| 5b `tool-module-keys` | `GW/services/tool-manifest.json`, validator in `module-catalog.ts` | IA-2b | Every manifest tool has a module key; the validator fails on an unknown key. |
| 5c `pilot-flow` | `GW/services/community-autopilot/action-registry.ts`, its test | 5a, 5b | Community Autopilot already writes `agent_runs` with principal user, tenant, role and channel. Add module and trace. An integration test over an in-memory DB shows one request producing joinable records with every field above. |

**Deferred.** A `tenant_id` column on `oasis_events`. It is a hot, I/O-sensitive table and needs MT and owner agreement.

### IA-6 `ia-module-aware-healing` (WS6), 7 lanes, L

- **Objective.** Make the existing L1/L3 pipeline module-aware and prove one cycle on a pilot module:
  1. detection;
  2. impact;
  3. test selection;
  4. controlled repair;
  5. verification;
  6. learning.
- **Out of scope:**
  - a new orchestrator;
  - any change to the autonomy level, the sparring mode or `EXECUTION_DISARMED`;
  - autonomous fixes outside `services/gateway/src/**`.

| Lane | Paths | Depends on | Acceptance |
|---|---|---|---|
| 6a `intake-alert-endpoints` | `GW/routes/self-healing.ts` (20 lines or fewer), `GW/types/self-healing.ts` | — | `alert-workflow://<WORKFLOW>` is accepted and mapped to a module and an owning loop. Unit test with each of the 7 workflow ids. Reliability fix, independent of the rest. |
| 6b `module-key-columns` | `P:supabase/migrations/<IA range>_ia_module_key.sql`, rollback, queue row, `DATABASE_SCHEMA.md` | owner migration approval | Expand-only: nullable `module_key`, `tenant_id` and `role` on `self_healing_log` and `dev_autopilot_outcomes`. Read-only post-check. Rollback SQL in `docs/validation/<VTID>/`. |
| 6c `injector-module-map` | `GW/services/self-healing-injector-service.ts` | 2b, 6b | `mapServiceToModule` is replaced by catalog lookup. New incidents carry `module_key` (test). |
| 6d `module-test-selection` | `GW/services/jev/gates/test-selection-gate.ts` (shadow), TEST-CATALOG module key | 2b, 2d | Shadow only: for a changed path, list the selected suites by module and graph dependents, and compare against the full run in the PR evidence. |
| 6e `loop-owner-module` | `GW/specs/loop-catalog-v1.json`, `loop-catalog.ts`, test | 2b | Every loop has an owner and a module set. The test fails on a missing owner. |
| 6f `vcaop-adr` | `P:vcaop/adr/` or `docs/decisions/` | decision 0.7 | ADR merged. No code. |
| 6g `pilot-cycle` | tests and validation only | 6a-6e | On the pilot module, chosen by criteria (no active MT or Health lane, a dedicated suite, a health route): **calendar** is the first candidate, **llm** the platform-only alternative. A synthetic incident in CI or locally produces the module key, graph dependents, the selected tests, a fix through the existing pipeline at the unchanged autonomy level, verification, and an outcome row with the module key. Never run against production. |

### IA-7 `ia-progressive-adoption` (WS7), planned after the IA-6 pilot

**A module is adopted when it has:**
1. a complete catalog entry with owner;
2. a generated contract (routes, events, tables written);
3. tests selectable by module;
4. a health check that checks something;
5. its sensors routed to the intake with a module key;
6. its tenancy class recorded.

**Order:**
1. Platform modules first: llm, deploy, oasis, agents, infra.
2. Member modules only after their MT lanes are `done`:
   - community after WS3;
   - messenger after `mt-network-r2`;
   - health after the Health programme lanes;
   - commerce after WS11;
   - admin/tenancy after WS1 and WS4.

**Completion metric:** adopted modules / 20 candidate modules (E §2), reported per module.

## 5. VTID breakdown

| Plan | Lanes, one VTID each | Change class |
|---|---|---|
| `mt-track-s-authz` (Track S, PR #4579) | 2 (`approvals-auth`; `work-surface-permission` with the text path) | standard |
| IA-1 | 1 | standard (docs) |
| IA-2 | 4 | standard |
| IA-3 | 3 | standard |
| IA-4 | 4 | standard, hot files |
| IA-5 | 3 | standard |
| IA-6 | 7 (one migration lane) | standard; the migration needs owner approval |
| **Total before IA-7** | **24** | |

## 6. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| MT plans stay pending | IA-3 and IA-4 cannot start | IA-1 and IA-2 touch no MT files; IA-3a can be co-designed now; code waits |
| Hot-file collisions (`orb-live.ts`, `live-session-controller.ts`, `orb-tools-shared.ts`, `tenant-context.ts`, `index.ts`) | merge conflicts, regressions | 20-line PRs, serialized landing, explicit order with the `mt-packs-r2` and `mt-network-r2` drivers |
| The work-surface check changes a contract the role suite describes (`vtid-04560…:108-110` "never community") | reviewers read it as a regression | `mt-track-s-authz` keeps the pure resolver unchanged and states the contract change in its PR (rule 42h) |
| PLAN-SPAR capacity (2 sessions) | IA plans delay MT re-plans | one IA plan in flight at a time; MT first |
| The registry becomes another stale document | wrong impact analysis | generated artifacts, `--check` in CI, an extended drift guard, the validator fails on dead references |
| Staging shares the production DB | write paths cannot be tested on staging | in-memory unit and integration tests; read-only staging suites; the `mt-guardrails-r2` local stack for SQL (VTID-05447) |
| Module metadata used to widen autonomy | larger blast radius | metadata stays advisory in IA-6; any autonomy change is a separate plan with owner approval |
| The sparring gate is switched to `enforce` | self-healing and Dev Autopilot stop | flagged in F §8; decision 0.5 comes first |
| Cognito sessions lack the exafy flag | the work-surface check denies Cognito developers without a granted role | `mt-track-s-authz` checks permitted roles in the DB, not only the claim |
| Cross-tenant memory | privacy breach | no cross-tenant memory change until decision 0.4 |

## 7. Required approvals

| Item | Approver | Mechanism |
|---|---|---|
| `mt-track-s-authz` | PLAN-SPAR policy, or owner if escalated | PR #4579 |
| Each IA plan | PLAN-SPAR policy, or owner Gate 1 if escalated | `plan(<slug>)` PR |
| Context-contract interfaces | MT planner seat `hotmail`; `mt-identity-r2` and `mt-packs-r2` drivers | recorded in the IA-3 plan and sparring record |
| IA-6b migration | Owner (§7d), with Lane A queue review | `RUN-MIGRATION.yml` with an explicit `target` |
| Autonomy level, sparring mode, kill switches | Owner | separate plan; not part of IA |
| Production for any IA change | Owner at Gate 2 | PUBLISH or an owner-commanded publish |

## 8. What this proposal does not do

- **No changes to the MT foundations:** RLS, membership, provisioning, tenant migrations, MT flag defaults, TenantContext
  resolution.
- **No second assistant, orchestrator, healing pipeline, tracker or registry** beside the atlas and the loop catalog.
- **No microservices and no code moves.**
- **No VTID allocation by hand and no production writes.**
