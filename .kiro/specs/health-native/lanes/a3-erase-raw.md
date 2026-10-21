---
lane: a3-erase-raw
state: in-review
next_actor: kiro
vtid: VTID-05160
depends_on: [phase1-data-core]
executor: claude
reviewer_seat: claude
paths:
  - "src/**"
  - "i18n-source-stamps/**"
  - "docs/SCREEN_INVENTORY.md"
  - "docs/validation/**"
  - "tests/**"
updated: 2026-10-21T13:10Z
---
# A3 — account deletion erases health raw batches (vitana-v1 #1380)

Tasks: `tasks.md` section "a3-erase-raw".

vitana-v1 #1380, green. Merges after A2 (#4105) is merged (it calls A2's `erase-raw`).

## Log
### 2026-10-15T18:59Z · session_01VuZPi9pvHaUverAXRC1WvU · (backfill) → in-review
Handed over to Kiro with the health-native spec. next_actor: claude.
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
### 2026-10-21T10:10Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:12Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:40Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:42Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:44Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:46Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:48Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:50Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:52Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:54Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:56Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T10:58Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:00Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:02Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:04Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:06Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:08Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:10Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:12Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:42Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:44Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:46Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:48Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:50Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:52Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:54Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:56Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T11:58Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:00Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:02Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:04Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:06Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:08Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:10Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:12Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:14Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:42Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:44Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:46Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:48Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:50Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:52Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:54Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:56Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T12:58Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T13:00Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T13:02Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T13:04Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T13:06Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T13:08Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
### 2026-10-21T13:10Z · pm-agent · update
reassign review claude→exafyltd (stale_review, Claude unavailable)
