# Vitanaland Integrated Architecture: Engineering Assessment

First deliverable of the Integrated Architecture Development Directive (§13). Supporting record of plan
`ia-architecture-map`, which lands the condensed map in `docs/architecture/integrated-architecture/`.

| | |
|---|---|
| Status | Assessment, read-only. Records the state at its pins; rule text and code on `origin/main` win over it. |
| Baseline | `vitana-platform` `62990ce285`, `vitana-v1` `58c76c956` (2026-11-01). Files cited for the authorization findings are unchanged at `900d76c485`. |
| Also read | 13 unmerged multi-tenant (MT) plan branches, the MT re-plans of 2026-11-01 (`origin/kiro/mt-*-r2`), the open PRs |
| Merged into the MT programme | The initiative runs as workstream WS-IA of `docs/programs/multi-tenant/program.md`; MT exit criteria are unchanged |

## How to read this

| File | Directive §13 item |
|---|---|
| [A-repository-map.md](A-repository-map.md) | A. Current-state repository map |
| [B-multi-tenant-protection.md](B-multi-tenant-protection.md) | B. Multi-Tenant protection report |
| [C-identity-and-context.md](C-identity-and-context.md) | C. User identity and context assessment |
| [D-vitana-architecture.md](D-vitana-architecture.md) | D. Vitana architecture assessment (ORB, voice, conversation, memory, tools, Autopilot chain) |
| [E-modularisation.md](E-modularisation.md) | E. Modularisation assessment |
| [F-autonomous-engineering.md](F-autonomous-engineering.md) | F. Autonomous engineering assessment |
| [G-implementation-proposal.md](G-implementation-proposal.md) | G. Implementation proposal (sequence, plan breakdown, dependencies, risks, acceptance, approvals) |

Authorization findings made during the assessment are handled in the Track S plan `mt-track-s-authz` (PR #4579) and
are described there, not here.

Evidence conventions: `P:` = vitana-platform, `V1:` = vitana-v1, `GW` = `P:services/gateway/src`. A `file:line` was read at the
baseline. **[code]** = verified in source, **[git]** = verified in git history or branches, **[doc]** = stated in repo
docs and not independently checked, **[unverified]** = could not be confirmed from the repository.

Limits. No live system was queried or probed: staging writes to the production database (CLAUDE.md rule 48).
Deployment state comes from repo records (lane files, `MIGRATION-QUEUE.md`, workflows). Live database grants,
`system_config` values and ECS task-definition env values are not visible from the repository. Early in the
assessment the GitHub REST API answered HTTP 403, so the first open-PR list came from the public github.com listing;
later calls worked and B §0 uses them.

## Headline findings

1. **Authorization first.** Places where a client-supplied value decides a privilege are fixed in Track S plan
   `mt-track-s-authz` (#4579), registered in the multi-tenant programme and sequenced before `mt-packs-r2`
   `persona-pack`, which shares three files.
2. **The Multi-Tenant programme is mostly plans, and they are moving.**
   - Done and in production: lanes S-M, A, B, C (VTID-05147, 05149, 05150, 05151).
   - Merged but dark: the mt-jobs code (VTID-05267, 05268, 05270).
   - On 2026-11-01 session `kiro-hotmail-202611011452-6d16` re-planned all twelve escalated MT plans under `-r2`/`-r3`
     slugs. `mt-track-s-r2` (VTID-05441/05442) and `mt-guardrails-r2` (VTID-05443–05448) are approved by policy; ten
     are drafted. `docs/owner/approve-11.sh` targets the superseded sessions (B §0).
3. **TenantContext is built but not used.**
   - `requireTenant` and `requireAuthWithTenant` attach `req.tenant`, but no file outside the middleware reads it. Routes
     read `identity.tenant_id` (about 383 references).
   - 65 gateway files query `user_tenants` directly.
   - `tenantDb`, `is_member` and `tenant_id_for_policies` do not exist yet. `mt-identity-r2` plans them.
4. **"One Vitana that adapts to role and surface" already exists.** `ROLE_REGISTRY` (`GW/orb/profile/role-registry.ts`)
   and the Assistant Profile (`assistant-profile.ts`) map each role to a surface, persona, tool packs, knowledge packs,
   opener and memory scope. The gap is not the concept. The gaps are three:
   - role selection is used as authorization;
   - the declared memory scope is never enforced;
   - text paths carry at most a fixed screen label, never the real route or screen.
5. **There is no canonical context object.** At least 13 types carry overlapping subsets of user, tenant, role, working
   context and permissions (C §7). Voice and text resolve context through two different code paths (D §4).
6. **Module metadata exists in pieces, and the pieces do not share a key.**
   - `DOMAIN_ATLAS` (15 domains) is drift-guarded: every one of the 432 gateway route files must be claimed.
   - `docs/programs/areas.yaml` is the only machine-readable ownership.
   - `V1:src/design/screen-manifest.json` assigns all 340 frontend routes to 18 areas.
   - Six taxonomies (atlas domains, health groups, ledger modules, impact categories, service-path-map, loop catalog
     groups) share no join key.
7. **Autonomous engineering is real but blind to modules.**
   - L1 Repair and L2 Build and Release are live.
   - `self_healing_log` has no module, tenant or role column.
   - All seven `ALERT-*` workflows report to the self-healing intake with an `alert-workflow://` endpoint that the intake
     rejects as unknown (F §3).
   - VCAOP runs a second healing stack with no bridge to the central one.
8. **Execution traceability is partial.**
   - `agent_runs` has the right shape: principal, user, tenant, VTID, root run.
   - Only Community Autopilot actions and persisted delegations write it.
   - `vtid_ledger` has no user or tenant column, and `oasis_events` has no `tenant_id` column.
   - Nothing links an ORB turn to an execution run to verification evidence with one id.
9. **The governance gate does not cover autonomous producers.**
   - Plan sparring is in `log` mode.
   - Self-healing and Dev Autopilot allocate VTIDs with no sparring record.
   - Switching the gate to `enforce` would stop both, because no machine-producer policy exists.

## How the initiative joins the multi-tenant build

- **One programme.** IA specs are listed in `docs/programs/multi-tenant/program.md` as workstream WS-IA; MT exit
  criteria are unchanged (directive §2.2 rule 10).
- **One queue.** IA plans go through the same `plan(` → PLAN-SPAR → lanes → reviewer agent → §7b → STAGING-VERIFY
  pipeline, after the MT plans they depend on (G §3).
- **No relay, no shared edits.** Each plan has one driver. The MT driver keeps its plans; IA plans have their own.
  Neither edits the other's spec, lane or hand-off files (collaboration.md §5, §7a). Shared files are declared in each
  IA `plan.md` with their order.
- **One migration queue.** IA migrations get their own version range and a row in `docs/multitenancy/MIGRATION-QUEUE.md`.
- **Inputs the IA plans take from MT plans:** `mt-guardrails-r2` `generated-inventories` (VTID-05445) feeds the module
  graph; `mt-identity-r2` (single selected-role source, `tenantDb`) feeds the context contract; `mt-packs-r2`
  `persona-pack` lands before the ORB context work.
- **One requirement on an MT plan, recorded for its planner:** `mt-identity-r2` makes `user_tenants.active_role` the
  single role source and derives "the other role sources" from it (its `plan.md` lane 4). The grants in
  `user_permitted_roles` must stay separate from the selected role. `requireTenantAdmin` (VTID-05147) and
  `mt-track-s-authz` both authorize from grants, not from the selection.

## Decisions for the owner

1. **Do not run `docs/owner/approve-11.sh`.** It approves the escalated sessions that the `-r2` re-plans replaced.
2. **Which Kiro seat drives the IA plans** after this session. The session's account was not readable, so its id
   carries no seat; lanes take their seats from `docs/programs/areas.yaml`.

## Definition of success: where the platform stands

| Directive §14 outcome | Today | Main gap | Plan |
|---|---|---|---|
| One Vitana Life Companion per user | One assistant, role-separated personas (VTID-04560) | Memory is read per (tenant, user), so continuity breaks when a dual member switches tenant | IA-3 / IA-4, with MT decision D8 |
| Multiple tenants and roles | Data model allows it; one active tenant per session; one selected role per tenant | Role scope (platform vs tenant) is implicit; the permitted-role union is computed in three places | IA-3 (after `mt-identity-r2`) |
| Understands environment and task | Voice gets route and surface, refreshed mid-session | Text paths get at most a fixed label; there is no task dimension; screens are route strings, not registry ids | IA-4 |
| Guidance and execution adapt to context | Tool packs per role; surface gate | The served role comes from the declared surface; the dispatcher role-policy runs in shadow only | `mt-track-s-authz`, then IA-4 |
| Personal and organisational data separated | RLS plus membership check (VTID-05043); work-surface marker | MT policy rewrite not started; KB search is global; `ROLE_REGISTRY.memoryScope` is unenforced | MT programme; IA-4 |
| Modular, independently maintainable | Atlas plus drift guard; areas.yaml | No module manifest, no module dependency graph, no per-module tests | IA-2 |
| Autopilot finds the right capabilities | Tool catalog plus surface gate; `agents_registry` v2 cards | Registry cards are not used for selection; no module key on tools | IA-5 |
| Self-healing improves modules | L1/L2 live, L3 partial | No module or tenant key on incidents; ALERT reports dropped at intake | IA-6 |
| MT evolves without conflict | Separate programme with its own queue | Hot files shared with MT re-plans | B §8-9, G §3 |
