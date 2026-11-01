---
lane: health-tenant-accessor
state: ready
next_actor: kiro
depends_on: [health-home-tenant-db]
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/data/health-db.ts
  - services/gateway/src/routes/integrations-repository.ts
  - services/gateway/src/services/diary-health-extractor-repository.ts
  - services/gateway/src/routes/health-repository.ts
  - services/gateway/src/routes/health.ts
  - services/gateway/src/services/automation-handlers/health-wellness-repository.ts
  - services/gateway/src/services/automation-handlers/health-action-initiative-repository.ts
  - services/gateway/scripts/gen-health-reader-inventory.mjs
  - services/gateway/test/mt-native-health/health-reader-inventory.test.ts
  - services/gateway/test/mt-native-health/health-db.test.ts
updated: 2026-11-01T15:37Z
repos: [exafyltd/vitana-platform]
---
# User-keyed healthDb accessor + inventory lint — mt-native-health-r2/health-tenant-accessor (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health-r2/plan.md` (authoritative) and the `health-tenant-accessor` group of `tasks.md`
(tasks A1–A5, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

The VTID comes from PLAN-SPAR on convergence, never by hand.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane's file, no merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed
paths. Reference mt-identity-r2's `isHealthTable()` for the table set — never re-list health tables (CROSS-SPEC O1).
Add `docs/validation/<vtid>/plan-sparring.md` (copy), `scope.json`, `staging-tests.json`.

Branch `kiro/mt-native-health-r2/health-tenant-accessor`; PR title
`VTID-xxxxx (mt-native-health-r2/health-tenant-accessor): …`; commit trailers `Collab-Session: <your kiro session id>`
and `Collab-Lane: mt-native-health-r2/health-tenant-accessor`. When the PR is open: set `state: in-review`,
`next_actor: kiro` (reviewer seat `hotmail`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:37Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-native-health/health-tenant-accessor`. Answers R3-F1 (`.maybeSingle()` with home-tenant semantics; the swallowed `PGRST116` is removed) and R3-F2 (each (b) inventory entry gets a `reason`).
