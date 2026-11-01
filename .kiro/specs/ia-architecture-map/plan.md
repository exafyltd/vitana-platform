---
change_class: standard
---
# plan(ia-architecture-map): the Integrated Architecture map, joined to the multi-tenant programme as WS-IA

Author: Kiro, session `kiro-202611011939-b712` (Kiro Web; the account seat was not readable, so the id carries no
seat). vitana-platform premises pinned to `origin/main` `900d76c485`, vitana-v1 to `a41e89a0d` (2026-11-01).
Supporting record: `assessment/` in this folder (the read-only assessment of directive §13, items A–G).

<!-- plan:begin -->
## 1. Goal
The owner's Integrated Architecture directive (2026-11-01) asks first for an evidence-based current-state assessment
(§13 A–G) and then for "one authoritative architecture map" with the real source paths of both repositories
(Workstream 1). The owner then asked: *"how can this plan be added to the ongoing multi tenant building, so we merge
both sessions"* (2026-11-01). This plan does both, with documents only:
1. Lands the map and gap analysis in `docs/architecture/integrated-architecture/`, re-verified at the lane base.
2. Registers the initiative as workstream WS-IA of the multi-tenant programme, without changing its exit criteria
   (directive §2.2 rule 10).
3. Records the order of the later IA plans relative to the multi-tenant plans (§4), so the multi-tenant driver and the
   IA driver work from one sequence without editing each other's specs (`collaboration.md` §5, §7a).

## 2. Today (evidence; read each file at the pin)
- `docs/architecture/` on `main` holds one file, `cognee-integration-design.md`. No document on `main` maps identity,
  tenant, role, working context and permissions together, or the ORB, memory, execution and autonomy chains with
  their source paths.
- `docs/programs/multi-tenant/program.md` lists the specs `multi-tenant`, `mt-jobs` and `mt-launch` and two exit
  criteria (front matter `:7-17`). Plan `mt-track-s-authz` (PR #4579) adds itself there.
- `docs/CONTEXT-MAP.md` has no row that names an architecture map. `node scripts/dev/context.mjs check`
  (`scripts/dev/context.mjs:360-400`) fails on a dead link in `CONTEXT-MAP.md` and warns on dead paths in the rule
  files, so a new row is checked by CI (`UNIT.yml` runs `scripts/dev/context.test.mjs`).
- The multi-tenant re-plans of 2026-11-01 that the IA plans depend on (branches `origin/kiro/<slug>/_plan`):
  `mt-guardrails-r2` is approved (VTID-05443–05448; lane `generated-inventories`, VTID-05445,
  `scripts/mt/inventory/**`); `mt-identity-r2` is drafted, its lane 4 `role-source-and-bootstrap` makes
  `user_tenants.active_role` the single role source (`.kiro/specs/mt-identity-r2/plan.md:164-171`); `mt-packs-r2` is
  drafted, its lane `persona-pack` claims `services/gateway/src/orb/profile/**`, `routes/orb-live.ts` and
  `orb/live/session/live-session-controller.ts`.
- Existing module metadata the later plans extend: `services/gateway/src/orb/developer/domain-atlas.ts` (15 domains,
  route-claim drift guard `services/gateway/test/vtid-04560-role-separation-regression.test.ts:524-529`),
  `docs/programs/areas.yaml`, vitana-v1 `src/design/screen-manifest.json`, `services/gateway/specs/loop-catalog-v1.json`
  with its loader `services/gateway/src/services/loop-catalog.ts`.

## 3. Lane `map-doc`
Paths: `docs/architecture/integrated-architecture/**`, `docs/CONTEXT-MAP.md`, `docs/validation/**`.
1. Re-check every `file:line` in `assessment/` against the lane base with a small script kept in
   `docs/validation/<VTID>/` (path exists; line within the file). Correct each drifted reference in the published copy.
2. Publish `docs/architecture/integrated-architecture/` = `README.md` (the map: the five context dimensions, the ORB
   voice and text turn, memory and knowledge, the execution chain, module metadata, autonomous engineering, each with
   source paths in both repositories) plus sections A–G from `assessment/`, with their pins stated.
3. Add one `docs/CONTEXT-MAP.md` row: "Where is the integrated architecture map?" →
   `docs/architecture/integrated-architecture/README.md`.
4. Authorization findings are referenced to `mt-track-s-authz`, not described.
Test that fails on base: `context.mjs check` with the new `CONTEXT-MAP.md` row reports a dead link until the README
exists; it reports zero errors after.

## 4. Order of the IA plans relative to the multi-tenant plans (the shared sequence)
Each later IA plan is its own `plan(` PR, sparred and approved on its own, opened when its inputs are met:
| IA plan | Opens when | Input from the multi-tenant programme |
|---|---|---|
| `ia-module-registry` (catalog + generated module graph; extends the atlas) | this plan is approved | joins `mt-guardrails-r2` `generated-inventories` output; never builds a second table/route inventory |
| `ia-context-contract` (one server-derived context shape) | `mt-track-s-authz` merged and `mt-identity-r2` approved | `TenantContext`, `tenantDb`, the single selected-role source; grants stay a separate store |
| `ia-orb-context` (voice and text read the same context; memory scope enforced) | `ia-context-contract` done and `mt-packs-r2` `persona-pack` merged | persona and pack facts land first; recipient scope stays with `mt-network-r2` |
| `ia-execution-trace` (one trace id from ORB turn to verification) | `ia-module-registry` and `ia-context-contract` done | `orb-tools-shared.ts` changes are sequenced after `mt-network-r2` and `mt-packs-r2` `kb-overlay-code` |
| `ia-module-aware-healing` (module key on incidents and outcomes; ALERT intake) | `ia-module-registry` done | its migration takes an IA version range and a `docs/multitenancy/MIGRATION-QUEUE.md` row |
| `ia-progressive-adoption` | the healing pilot is verified | a member module is adopted only after its multi-tenant lanes are `done` |
One requirement on a multi-tenant plan, recorded for its planner: `mt-identity-r2` keeps the grants in
`user_permitted_roles` separate from the selected role, because `requireTenantAdmin`
(`services/gateway/src/middleware/require-tenant-admin.ts:143-158`) and `mt-track-s-authz` authorize from grants.

## 5. Parallel work, shared and hot files
The lane changes documents only and shares no file with any multi-tenant or Track S lane. `docs/CONTEXT-MAP.md` is
not a hot file. The plan PR edits `docs/programs/multi-tenant/program.md`, which PR #4579 also edits; the second to
merge takes both list entries.

## 6. Tests and commands
`node scripts/dev/context.mjs check` (zero errors), the reference-check script of §3.1 (zero unresolved), `node --test
scripts/dev/context.test.mjs`. `docs/validation/<VTID>/staging-tests.json` carries an `existing` reference to the
`context.mjs check` run: documents deploy nothing.

## 7. Measurement
`docs/validation/<plan VTID>/timings.json` (`collaboration.md` §8b).

## 8. Risks
- The map drifts from the code. Mitigation: every section states its pin; the CONTEXT-MAP row is link-checked; later
  IA plans replace prose with generated artifacts (module graph).
- The multi-tenant re-plans change during sparring. Mitigation: §4 names plans and lanes, not their internals; an IA
  plan re-checks its inputs when it opens.

## 9. Unchanged
No code, migration, flag, workflow, rule file or multi-tenant spec changes. Multi-tenant exit criteria are unchanged.
<!-- plan:end -->
