---
lane: db-cohost-authz
state: ready
next_actor: kiro
branch: kiro/live-room-edit-cohost/db-cohost-authz
depends_on: []
executor: kiro
seat: exafy
area: platform
repos: [exafyltd/vitana-platform]
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261105170000_live_room_cohost_authz.sql
  - scripts/ci/sql-tests/run-live-room-cohost-test.sh
  - scripts/ci/sql-tests/live-room-cohost.sql
  - .github/workflows/SQL-LIVE-ROOM-COHOST.yml
  - DATABASE_SCHEMA.md
updated: 2026-11-05T16:40Z
---

# Lane: db-cohost-authz (repo exafyltd/vitana-platform)

Host helper `live_room_is_host`, co-host validation `live_room_filter_co_hosts`, the 13 host gates, the guard on
browser writes to `community_live_streams.co_hosts`. Tasks T1-T5 in tasks.md. Applying the migration is an owner stop
(collaboration.md §7d).

## Log
### 2026-11-05T16:40Z · kiro-jtadic-202611051617-04a8 · ready
Lane created with the plan.
