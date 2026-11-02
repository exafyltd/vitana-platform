---
lane: health-analytics-lineage-guard
state: ready
next_actor: kiro
depends_on: [health-tenant-accessor]
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/scripts/gen-health-lineage-inventory.mjs
  - services/gateway/test/mt-native-health/health-lineage-guard.test.ts
  - services/gateway/test/mt-native-health/health-lineage-guard.pgtap.sql
  - services/gateway/src/constants/health-lineage-exempt.ts
  - services/gateway/test/mt-native-health/health-lineage-inventory.json
updated: 2026-11-01T15:37Z
repos: [exafyltd/vitana-platform]
---
# Tenant-analytics/commerce health-read guard — mt-native-health-r2/health-analytics-lineage-guard (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health-r2/plan.md` (authoritative) and the `health-analytics-lineage-guard` group of
`tasks.md` (tasks G1–G4, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

This lane implements program §9 (D18): tenant operators/owners and commerce readers never read health data. It is
the standing build-failing guard; the live S-L leak itself is removed by mt-tenant-admin — do not re-own S-L here.
The forbidden-table set is `isHealthTable` imported from `services/gateway/src/services/tenancy/is-health-table.ts`
(mt-identity-r2 lane `tenant-db-and-slug-cleanup`; never re-listed — CROSS-SPEC O1). **Cross-spec dependency:** do not
start until that file is on main. Commit the generated inventory as `health-lineage-inventory.json`; the test
regenerates it and fails on drift.
Member-coaching modules are the only exemption; list each with a one-line reason in `health-lineage-exempt.ts`.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane's file, no merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed
paths. Add `docs/validation/<vtid>/plan-sparring.md` (copy), `scope.json`, `staging-tests.json`.

Branch `kiro/mt-native-health-r2/health-analytics-lineage-guard`; PR title
`VTID-xxxxx (mt-native-health-r2/health-analytics-lineage-guard): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-native-health-r2/health-analytics-lineage-guard`. When the
PR is open: set `state: in-review`, `next_actor: kiro` (reviewer seat `hotmail`), `pr: <url>`, append a log entry,
release the claim.

## Log
### 2026-11-01T15:37Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-native-health/health-analytics-lineage-guard`. Versions day-shifted to `20261102130*`. Executor and reviewer follow today's §3a/§7 rules.
