---
lane: health-db-accessor
state: ready
next_actor: owner
depends_on: [health-home-tenant-db]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/services/health-db.ts
  - services/gateway/src/routes/integrations-repository.ts
  - services/gateway/src/routes/health-repository.ts
  - services/gateway/src/services/automation-handlers/health-wellness-repository.ts
  - services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts
  - services/gateway/src/services/diary-health-extractor-repository.ts
  - services/gateway/test/services/mt-native-health-healthdb.test.ts
updated: 2026-10-17T13:30Z
---
# healthDb(userId) accessor + TENANT_TABLES exclusion + reader/writer conversion — mt-native-health (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (health-db-accessor) and `tasks.md`. Design: `design.md`.

HELD until PLAN-SPAR allocates this lane's VTID. Depends on `health-home-tenant-db` (reads `health_home_tenant_id`) and
on `mt-identity`'s `TENANT_TABLES`/`tenantDb` and `isHealthTable()` (cross-spec; health tables are EXCLUDED from
`TENANT_TABLES` and referenced via `isHealthTable()`, never a local list — CROSS-SPEC O1). Dark behind
`mt.health_home_tenant`.

The repository file paths above are the named session-tenant readers/writers from MULTI-TENANT-PLAN §4.9, at their REAL
locations verified 2026-10-17 (`routes/integrations-repository.ts`, `routes/health-repository.ts`,
`services/automation-handlers/health-wellness-repository.ts`,
`services/automation-handlers/health-action-initiative-repository.ts`,
`services/diary-health-extractor-repository.ts` — there is no `services/gateway/src/repositories/` dir and no
`services/health/` dir). The new accessor lives at `services/gateway/src/services/health-db.ts`. The executor
re-verifies each path at build time (names may drift) and routes them through `healthDb(userId)`; a generated inventory
+ lint fails the build on any health reader/writer that bypasses it. The lane also states whether `healthDb` subsumes
the existing ORB resolver `resolveHealthTenantId()` (`services/gateway/src/services/orb-tools/health-depth-tools.ts:118`,
a session/`user_tenants` resolver) so the two do not diverge — the frozen-home-tenant rule is authoritative.

§7a: no VTID allocation, no `_plan` claim, no merge/approve/deploy, no live writes. Allowed paths only. Own
`docs/validation/<vtid>/` (plan-sparring copy, scope.json, staging-tests.json) — not in `paths`.

PR title `VTID-xxxxx (mt-native-health/health-db-accessor): …`; trailers `Collab-Session: <id>`,
`Collab-Lane: mt-native-health/health-db-accessor`.

## Log
### 2026-10-17T11:48Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created (held). `healthDb(userId)` resolves the frozen home tenant; health tables excluded from `TENANT_TABLES`;
convert the §4.9 readers/writers; lint fails on a bypass.

### 2026-10-17T13:30Z · kiro-hotmail-202610151618-b437 · internal-review fix (ready)
Internal review HIGH W3: lane `paths` pointed at a non-existent `services/gateway/src/repositories/` dir and a
`services/health/` dir. Corrected to the real paths (`routes/*-repository.ts`,
`services/automation-handlers/*-repository.ts`, `services/diary-health-extractor-repository.ts`) and placed the new
accessor at `services/gateway/src/services/health-db.ts`. Added the `resolveHealthTenantId()` convergence note.
