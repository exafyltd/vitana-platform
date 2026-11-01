---
id: multi-tenant
title: Multi-tenant Vitanaland
status: active
priority: 3
repos: [vitana-platform, vitana-v1]
specs:
  - vitana-platform:multi-tenant
  - vitana-platform:mt-jobs
  - vitana-platform:mt-launch
  - vitana-platform:mt-packs-r2
docs:
  - vitana-platform:docs/MULTI-TENANT-PLAN.md
  - vitana-platform:.kiro/specs/multi-tenant/plan-sparring.md
exit_criteria:
  - The exit criteria of docs/MULTI-TENANT-PLAN.md are met
  - Every lane of spec vitana-platform:multi-tenant is done
next_review: 2026-10-22
---
# Multi-tenant Vitanaland

Programme registry entry (VTID-05215). Links only; the plan is the source of truth.

- Plan: `vitana-platform:docs/MULTI-TENANT-PLAN.md`
- Spec: `vitana-platform:.kiro/specs/multi-tenant/` (handoff, requirements, design, tasks, lanes)
- Spec: `vitana-platform:.kiro/specs/mt-jobs/` (WS6: crons, heartbeat and automation events loop over every active tenant)
