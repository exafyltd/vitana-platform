---
lane: morning-health-pertenant
state: ready
next_actor: claude
depends_on: [provision-erp-monitoring-db]
executor: claude
reviewer_seat: jtadic
paths:
  - .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml
updated: 2026-10-15T16:40Z
---
# MORNING health per-tenant breakdown — mt-m3 (repo vitana-platform, executor claude)

Plan: `.kiro/specs/mt-m3/plan.md`; tasks W1–W2 in `tasks.md`; design in `design.md`. One edit to
`.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` adding a per-tenant isolation breakdown (read-only, report-only)
calling `ci_tenant_isolation_health_by_tenant()`, keeping the existing `ci_tenant_isolation_health()` row and the
report-only posture. `.github/**` is a governance path (collaboration §3a / queue.mjs `GOVERNANCE_PATHS`), so this lane
is `executor: claude`, `next_actor: claude` (Claude Code builds it; a Kiro seat reviews). Depends on
`provision-erp-monitoring-db` (the function must exist). The lane adds its own `docs/validation/<vtid>/` in a separate,
non-governance file set if evidence is needed.

Rules: Claude Code builds this governance lane; no deploy beyond the normal merge path; read-only, report-only. Branch
`claude/mt-m3/morning-health-pertenant`; PR title `VTID-xxxxx (mt-m3/morning-health-pertenant): …`; trailers
`Collab-Session` / `Collab-Lane: mt-m3/morning-health-pertenant`.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-m3 plan. Governance path → executor `claude`, `next_actor: claude`, reviewer seat `jtadic`; depends on
`provision-erp-monitoring-db`. Not owner-held (Claude builds governance lanes per the lane-assignment rule).
