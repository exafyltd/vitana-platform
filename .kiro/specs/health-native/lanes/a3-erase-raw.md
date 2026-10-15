---
lane: a3-erase-raw
state: in-review
next_actor: claude
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
updated: 2026-10-15T18:59Z
---
# A3 — account deletion erases health raw batches (vitana-v1 #1380)

Tasks: `tasks.md` section "a3-erase-raw".

vitana-v1 #1380, green. Merges after A2 (#4105) is merged (it calls A2's `erase-raw`).

## Log
### 2026-10-15T18:59Z · session_01VuZPi9pvHaUverAXRC1WvU · (backfill) → in-review
Handed over to Kiro with the health-native spec. next_actor: claude.
