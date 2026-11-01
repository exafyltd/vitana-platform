---
lane: engine-tenant-fallbacks
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/d46-anticipatory-guidance-engine.ts
  - services/gateway/src/services/d48-opportunity-surfacing-engine.ts
  - services/gateway/src/services/d49-risk-mitigation-engine.ts
  - services/gateway/src/routes/opportunity-surfacing.ts
  - services/gateway/test/mt-data-cleanup-engine-tenant.test.ts
updated: 2026-11-01T15:30Z
repos: [exafyltd/vitana-platform]
---
# engine-tenant-fallbacks — d46/d48/d49 never write the dead dev tenant (CODE) — mt-data-cleanup-r2

Plan: `../plan.md` ("Re-plan answers" R3-F2, Fix lane 5); tasks, paths and acceptance: `../tasks.md`
(`<!-- lane: engine-tenant-fallbacks -->`). The VTID comes from PLAN-SPAR on convergence, never by hand.

Scope: d46 keeps `tenantId = DEV_IDENTITY.TENANT_ID` (`…0001`, `:153`) on the authenticated path; d48 and d49 insert
whatever tenant the caller passes (`:894`/`:917`, `:519`). Outside `isDevSandbox()` each engine takes the tenant
from the authenticated caller (`resolvePrimaryTenant()`) or the explicit request context, and an empty or `…0001`
tenant inserts nothing (`TENANT_UNRESOLVED`). Dev-sandbox branches unchanged. Independent of the DB lanes.

Rules (§7a): no VTID allocation, no merge outside §7b, no deploy, no live write. Branch
`kiro/mt-data-cleanup-r2/engine-tenant-fallbacks`; PR title `VTID-xxxxx (mt-data-cleanup-r2/engine-tenant-fallbacks): …`;
trailers `Collab-Session` + `Collab-Lane: mt-data-cleanup-r2/engine-tenant-fallbacks`.

## Log
### 2026-11-01T15:30Z · kiro-hotmail-202611011452-6d16 · created → ready
New lane in the re-plan (answers R3-F2). Gateway code, seat `jtadic`.
