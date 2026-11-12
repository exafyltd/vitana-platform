---
lane: db-cohost-authz
state: in-review
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
updated: 2026-11-05T17:50Z
vtid: VTID-05558
claimed_by: kiro-exafy-202611051713-eefe
pr: https://github.com/exafyltd/vitana-platform/pull/4713
---

# Lane: db-cohost-authz (repo exafyltd/vitana-platform)

Host helper `live_room_is_host`, co-host validation `live_room_filter_co_hosts`, the 13 host gates, the guard on
browser writes to `community_live_streams.co_hosts`. Tasks T1-T5 in tasks.md. Applying the migration is an owner stop
(collaboration.md §7d).

## Log
### 2026-11-05T16:40Z · kiro-jtadic-202611051617-04a8 · ready
Lane created with the plan.

### 2026-11-05T16:35Z · ci-plan-spar · ready (VTID allocated)
VTID-05558 allocated after policy approval (converged-auto-v1).

### 2026-11-05T17:40Z · kiro-exafy-202611051713-eefe · ready → executing
Claimed and built under the lane's own seat (exafy), as lane-code.md step 1 prescribes; the plan driver session is kiro-jtadic-202611051617-04a8 (seat jtadic). Migration `20261105170000_live_room_cohost_authz.sql`, SQL test (PostgreSQL 16.2, red on base, three mutation checks), workflow `SQL-LIVE-ROOM-COHOST.yml`, schema row. Evidence in `docs/validation/VTID-05558/`.
Decisions inside the plan: (1) `kick`/`ban` refuse a host target only when the caller is not the room creator, so the creator can still remove a co-host (plan, Decisions taken). (2) Found while reading every body: `host_present` is one flag per room, so `live_room_set_host_present(false)` now keeps it while another host is still in the session; without this a co-host closing the tab would lock new guests out (`HOST_NOT_PRESENT`). (3) The original `live_room_set_host_present` also filtered `live_room_sessions` on a `current_session_id` column that no migration creates; the predicate is redundant (`id = NULL` matches nothing) and was removed. (4) The write guard keys on the database role (`current_user` in `authenticated`/`anon`), which is what PostgREST sets for a user JWT; the migration owner and `service_role` are unaffected. Not applied to any database: that is the owner's decision (§7d).

### 2026-11-05T17:50Z · kiro-exafy-202611051713-eefe · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4713. All 20 checks green on the previous head, including CI's own run of the SQL test on PostgreSQL 16.15 (`PASS vtid-05558 live room cohost`), Validator Check and Migration Drift Check. Next: the reviewer agent `vitana-lane-reviewer` on the final head, then merge under §7b. The migration is not applied by merging (owner decision, §7d).
