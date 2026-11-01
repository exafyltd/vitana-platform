---
lane: monitoring-erp-gw
state: ready
next_actor: kiro
depends_on: [provision-erp-monitoring-db]
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/routes/admin-health.ts
  - services/gateway/test/mt-m3-monitoring-erp*.test.ts
updated: 2026-11-01T15:43Z
repos: [exafyltd/vitana-platform]
---
# Per-tenant health surface + ERP-request display — mt-m3 (repo vitana-platform)

Plan: `.kiro/specs/mt-m3-r2/plan.md`; tasks M1–M4 in `tasks.md`; design in `design.md`. Surfaces
`ci_tenant_isolation_health_by_tenant()` on the existing admin health read and, per tenant, whether
`feature_flags.erp.bootstrap_requested` is set — display-only, no ERP action (the erp-bridge is execute-only; a consumer
is a separate ERP-bootstrap spec). Dark behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`. Depends
on `provision-erp-monitoring-db` (the function + flag must exist). The lane adds its own `docs/validation/<vtid>/`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch,
no Supabase/AWS writes. Work only inside the allowed paths. Branch `kiro/mt-m3-r2/monitoring-erp-gw`; PR title
`VTID-xxxxx (mt-m3-r2/monitoring-erp-gw): …`; trailers `Collab-Session` / `Collab-Lane: mt-m3-r2/monitoring-erp-gw`. When the
PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.


## Log
### 2026-11-01T15:43Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-m3/monitoring-erp-gw`. Answers R3-F2: a new route `/health/tenant-isolation` behind `requireAdminAuth`. The public routes are unchanged.
