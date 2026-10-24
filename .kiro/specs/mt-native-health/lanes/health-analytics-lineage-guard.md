---
lane: health-analytics-lineage-guard
state: ready
next_actor: owner
depends_on: [health-tenant-accessor]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
paths:
  - services/gateway/scripts/gen-health-lineage-inventory.mjs
  - services/gateway/test/mt-native-health/health-lineage-guard.test.ts
  - services/gateway/test/mt-native-health/health-lineage-guard.pgtap.sql
  - services/gateway/src/constants/health-lineage-exempt.ts
  - services/gateway/test/mt-native-health/health-lineage-inventory.json
updated: 2026-10-20T09:00Z
---
# Tenant-analytics/commerce health-read guard — mt-native-health/health-analytics-lineage-guard (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (authoritative) and the `health-analytics-lineage-guard` group of
`tasks.md` (tasks G1–G4, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates the VTID; it then flips to `kiro`. Start after the VTID
exists AND `health-tenant-accessor` is done (the guard builds on the same inventory tooling conventions).

This lane implements program §9 (D18): tenant operators/owners and commerce readers never read health data. It is
the standing build-failing guard; the live S-L leak itself is removed by mt-tenant-admin — do not re-own S-L here.
The forbidden-table set is `isHealthTable` imported from `services/gateway/src/services/tenancy/is-health-table.ts`
(mt-identity lane `tenant-db-and-slug-cleanup`; never re-listed — CROSS-SPEC O1). **Cross-spec dependency:** do not
start until that file is on main. Commit the generated inventory as `health-lineage-inventory.json`; the test
regenerates it and fails on drift.
Member-coaching modules are the only exemption; list each with a one-line reason in `health-lineage-exempt.ts`.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane's file, no merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed
paths. Add `docs/validation/<vtid>/plan-sparring.md` (copy), `scope.json`, `staging-tests.json`.

Branch `kiro/mt-native-health/health-analytics-lineage-guard`; PR title
`VTID-xxxxx (mt-native-health/health-analytics-lineage-guard): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-native-health/health-analytics-lineage-guard`. When the
PR is open: set `state: in-review`, `next_actor: kiro` (reviewer seat `hotmail`), `pr: <url>`, append a log entry,
release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Lane drafted by the hotmail Kiro seat (gateway/services work → seat `jtadic`, reviewer `hotmail`). HELD until
PLAN-SPAR allocates the VTID. Depends on `health-tenant-accessor`.
### 2026-10-20T09:00Z · kiro-hotmail-202610151618-b437 · ready (answered sparring round 1, session fca982e6)
R1-F3: no local `HEALTH_TABLES`; imports mt-identity's `isHealthTable` (O1, stated cross-spec dependency); generated
inventory committed as a fixture with a drift test. Added the fixture to paths.
