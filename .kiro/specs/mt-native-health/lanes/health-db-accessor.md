---
lane: health-db-accessor
state: ready
next_actor: owner
depends_on: [health-home-tenant-db]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/services/health/health-db.ts
  - services/gateway/src/services/health/**
  - services/gateway/src/repositories/integrations-repository.ts
  - services/gateway/src/repositories/diary-health-extractor-repository.ts
  - services/gateway/src/repositories/health-repository.ts
  - services/gateway/src/repositories/health-wellness-repository.ts
  - services/gateway/src/repositories/health-action-initiative-repository.ts
  - services/gateway/test/services/mt-native-health-healthdb.test.ts
updated: 2026-10-17T11:48Z
---
# healthDb(userId) accessor + TENANT_TABLES exclusion + reader/writer conversion — mt-native-health (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (health-db-accessor) and `tasks.md`. Design: `design.md`.

HELD until PLAN-SPAR allocates this lane's VTID. Depends on `health-home-tenant-db` (reads `health_home_tenant_id`) and
on `mt-identity`'s `TENANT_TABLES`/`tenantDb` and `isHealthTable()` (cross-spec; health tables are EXCLUDED from
`TENANT_TABLES` and referenced via `isHealthTable()`, never a local list — CROSS-SPEC O1). Dark behind
`mt.health_home_tenant`.

The repository file paths above are the named session-tenant readers/writers from MULTI-TENANT-PLAN §4.9; the executor
re-verifies each path at build time (names may have drifted) and routes them through `healthDb(userId)`; a generated
inventory + lint fails the build on any health reader/writer that bypasses it.

§7a: no VTID allocation, no `_plan` claim, no merge/approve/deploy, no live writes. Allowed paths only. Own
`docs/validation/<vtid>/` (plan-sparring copy, scope.json, staging-tests.json) — not in `paths`.

PR title `VTID-xxxxx (mt-native-health/health-db-accessor): …`; trailers `Collab-Session: <id>`,
`Collab-Lane: mt-native-health/health-db-accessor`.

## Log
### 2026-10-17T11:48Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created (held). `healthDb(userId)` resolves the frozen home tenant; health tables excluded from `TENANT_TABLES`;
convert the §4.9 readers/writers; lint fails on a bypass.
