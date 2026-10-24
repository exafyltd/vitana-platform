---
lane: health-tenant-accessor
state: ready
next_actor: owner
depends_on: [health-home-tenant-db]
executor: kiro
seat: jtadic
reviewer_seat: hotmail
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
updated: 2026-10-20T10:00Z
---
# User-keyed healthDb accessor + inventory lint — mt-native-health/health-tenant-accessor (repo vitana-platform)

Plan: `.kiro/specs/mt-native-health/plan.md` (authoritative) and the `health-tenant-accessor` group of `tasks.md`
(tasks A1–A5, allowed paths, acceptance). Design and the rules you must follow: `design.md`.

**HELD:** `next_actor: owner` until PLAN-SPAR allocates the VTID; it then flips to `kiro`. Do not start before the
VTID exists AND `health-home-tenant-db` is done (this lane calls `health_home_tenant_id()`).

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another
lane's file, no merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed
paths. Reference mt-identity's `isHealthTable()` for the table set — never re-list health tables (CROSS-SPEC O1).
Add `docs/validation/<vtid>/plan-sparring.md` (copy), `scope.json`, `staging-tests.json`.

Branch `kiro/mt-native-health/health-tenant-accessor`; PR title
`VTID-xxxxx (mt-native-health/health-tenant-accessor): …`; commit trailers `Collab-Session: <your kiro session id>`
and `Collab-Lane: mt-native-health/health-tenant-accessor`. When the PR is open: set `state: in-review`,
`next_actor: kiro` (reviewer seat `hotmail`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Lane drafted by the hotmail Kiro seat (gateway/services work → seat `jtadic`, reviewer `hotmail`). HELD until
PLAN-SPAR allocates the VTID. Depends on `health-home-tenant-db` (needs the resolver + column).
### 2026-10-20T09:00Z · kiro-hotmail-202610151618-b437 · ready (answered sparring round 1, session fca982e6)
R1-F2/F4: writers and readers convert in one PR behind one flag; flag off keeps the `limit(1)` path; the flip waits
for the backfill post-check; a read-only pre-flip count goes in `docs/validation/<vtid>/` (tasks A2). Paths unchanged.
### 2026-10-20T10:00Z · kiro-hotmail-202610151618-b437 · ready (answered sparring round 2, session fca982e6)
R2-F1: `fetchVitanaIndexScoreForDate` becomes `(sb, userId, date)` filtering `user_id` (+ home tenant via `healthDb`);
its caller GET /summary in `routes/health.ts` joins the paths (tasks A3).
