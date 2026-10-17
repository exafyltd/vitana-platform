---
lane: lineage-guard-health
state: ready
next_actor: claude
depends_on: [health-db-accessor]
executor: claude
reviewer_seat: hotmail
paths:
  - .github/workflows/mt-native-health-lineage-guard.yml
  - services/gateway/src/orb/live/tools/health-commerce-dispatch-guard.ts
  - services/gateway/test/guards/mt-native-health-lineage-guard.test.ts
  - services/gateway/test/orb/mt-native-health-dispatch.test.ts
updated: 2026-10-17T11:48Z
---
# Lineage guard (D18) + ORB health/commerce dispatcher rule — mt-native-health (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (lineage-guard-health) and `tasks.md`. Design: `design.md`.

**executor: claude, next_actor: claude** (CROSS-SPEC O1: "the governance SQL/workflow lane's executor is claude"; the
lane touches a `.github/workflows/**` governance path, which only a Claude Code session may change — collaboration §3a).
This lane is NOT owner-held; Claude Code builds it. Depends on `health-db-accessor` (the `healthDb`/`TENANT_TABLES`
exclusion the guard asserts against) and on `mt-identity`'s `isHealthTable()` predicate (referenced, not redefined).

Scope: a build-failing guard test (modelled on commerce architecture §7.2) that no tenant-admin/tenant-owner analytics
surface reads `health_*`/`wearable_*`/`biomarker_*`/`lab_*`/`vitana_index_*` (D18); the ORB tool-dispatcher
health/commerce rule (Apple 5.1.3), enforced in the dispatcher (not the declared catalog), covering `use_tool`, proven
on Nova and the Vertex Serbian bridge — **only if `health-native` has not already shipped it** (re-verify at slice
start; if shipped, drop the ORB half and keep the D18 guard). Required suite when the ORB dispatcher is touched:
`npm run test:roles` (42h).

Reviewer is a Kiro seat (hotmail), never Claude reviewing its own lane. No spoken sentence hardcoded (rule 41); the ORB
rule is enforced in code, not the prompt. Own `docs/validation/<vtid>/` — not in `paths`.

PR title `VTID-xxxxx (mt-native-health/lineage-guard-health): …`; trailers `Collab-Session: <claude session id>`,
`Collab-Lane: mt-native-health/lineage-guard-health`.

## Log
### 2026-10-17T11:48Z · kiro-hotmail-202610151618-b437 · created → ready
Lane created for Claude Code (governance path). Build-failing D18 analytics lineage guard + ORB dispatcher
health/commerce rule (re-verify whether health-native already ships the ORB half).
