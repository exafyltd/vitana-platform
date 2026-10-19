---
lane: monitoring-erp-gw
state: ready
next_actor: owner
depends_on: [provision-erp-monitoring-db]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/src/routes/admin-health.ts
  - services/gateway/test/mt-m3-monitoring-erp*.test.ts
updated: 2026-10-19T20:31Z
---
# Per-tenant health surface + ERP-request display — mt-m3 (repo vitana-platform)

Plan: `.kiro/specs/mt-m3/plan.md`; tasks M1–M4 in `tasks.md`; design in `design.md`. Surfaces
`ci_tenant_isolation_health_by_tenant()` on the existing admin health read and, per tenant, whether
`feature_flags.erp.bootstrap_requested` is set — display-only, no ERP action (the erp-bridge is execute-only; a consumer
is a separate ERP-bootstrap spec). Dark behind `MT_RESOLUTION_V2` + `tenant_settings.feature_flags.mt.*`. Depends
on `provision-erp-monitoring-db` (the function + flag must exist). The lane adds its own `docs/validation/<vtid>/`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch,
no Supabase/AWS writes. Work only inside the allowed paths. Branch `kiro/mt-m3/monitoring-erp-gw`; PR title
`VTID-xxxxx (mt-m3/monitoring-erp-gw): …`; trailers `Collab-Session` / `Collab-Lane: mt-m3/monitoring-erp-gw`. When the
PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

HELD: `next_actor: owner` until PLAN-SPAR allocates this lane's VTID.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-m3 plan. Held for PLAN-SPAR. Gateway lane, seat `jtadic`, reviewer `hotmail`; depends on
`provision-erp-monitoring-db`.
