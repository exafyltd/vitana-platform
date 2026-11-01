---
lane: morning-health-pertenant
state: ready
next_actor: kiro
depends_on: [provision-erp-monitoring-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml
updated: 2026-11-01T15:43Z
repos: [exafyltd/vitana-platform]
---
# MORNING health per-tenant breakdown — mt-m3 (repo vitana-platform, executor claude)

Plan: `.kiro/specs/mt-m3-r2/plan.md`; tasks W1–W2 in `tasks.md`; design in `design.md`. One edit to
`.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml` adding a per-tenant isolation breakdown (read-only, report-only)
calling `ci_tenant_isolation_health_by_tenant()`, keeping the existing `ci_tenant_isolation_health()` row and the
report-only posture. `.github/**` is a governance path (collaboration §3a / queue.mjs `GOVERNANCE_PATHS`), so this lane
is `executor: kiro`, `next_actor: kiro` (Kiro builds it; the reviewer agent accepts, §3a). Depends on
`provision-erp-monitoring-db` (the function must exist). The lane adds its own `docs/validation/<vtid>/` in a separate,
non-governance file set if evidence is needed.

Rules: Kiro builds this governance lane (executor kiro, accepted by the reviewer agent, §3a); no deploy beyond the normal merge path; read-only, report-only. Branch
`kiro/mt-m3-r2/morning-health-pertenant`; PR title `VTID-xxxxx (mt-m3-r2/morning-health-pertenant): …`; trailers
`Collab-Session` / `Collab-Lane: mt-m3-r2/morning-health-pertenant`.

## Log
### 2026-11-01T15:43Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-m3/morning-health-pertenant`. Executor moves from claude to kiro (governance path, not protected), with the reviewer agent.
