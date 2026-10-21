---
lane: d9-partner-dpa
state: in-review
next_actor: kiro
vtid: VTID-05090
depends_on: []
executor: claude
reviewer_seat: claude
paths:
  - "services/gateway/src/**"
  - "services/gateway/test/**"
  - "supabase/migrations/**"
  - "scripts/ci/sql-tests/**"
  - "DATABASE_SCHEMA.md"
  - "docs/programs/health-hub/**"
  - "docs/validation/**"
  - "src/**"
  - "i18n-source-stamps/**"
  - "docs/SCREEN_INVENTORY.md"
  - "docs/validation/**"
  - "tests/**"
updated: 2026-10-21T10:08Z
---
# D9 — partners read and sign the data processing agreement

Tasks: `tasks.md` section "d9-partner-dpa".

PRs: vitana-platform #4057 (VTID-05090, gateway: DPA versions, signatures, checklist, commerce-MCP link) and
vitana-v1 #1342 (VTID-05091, SetupHub DPA sheet). Both green except platform `drift`.

Blocked on: the owner applies `supabase/migrations/20261012200000_vtid_05090_partner_dpa.sql` (RUN-MIGRATION.yml).
Then: re-run `drift` on #4057 → merge #4057 → merge #1342 → STAGING-VERIFY → Gate 2. After #4057 merges, PLAT-FIX
"Change 6" (commerce-MCP link on the Terms/DPA step, VTID-05156 plan) follows as its own PR.

## Log
### 2026-10-15T18:59Z · session_01VuZPi9pvHaUverAXRC1WvU · (backfill) → in-review
Handed over to Kiro with the health-native spec. next_actor: owner.
### 2026-10-21T09:41Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T09:42Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T09:44Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T09:46Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T09:48Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T09:50Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T09:52Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T09:54Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T09:56Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T09:58Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:00Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:02Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:04Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:06Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:08Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
