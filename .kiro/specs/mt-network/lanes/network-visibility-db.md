---
lane: network-visibility-db
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
paths:
  - supabase/migrations/20261101051***_*.sql
  - supabase/tests/mt-network-visibility-db.pgtap.sql
updated: 2026-10-18T19:40Z
---
# mt-network/network-visibility-db — network_visible + connection RPCs (repo vitana-v1)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `network-visibility-db` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. **This is a vitana-v1 migration** — both `global_community_profiles` (v1 `20250917153624`) and `connection_requests` (v1 `20251111124306`) live in vitana-v1, not platform (R1-F5). Seat `exafyltd` (v1), reviewer `hotmail`.

DB lane (§4.7): migration + rollback + read-only pre/post checks in the PR; own `docs/validation/<vtid>/`. Adds `global_community_profiles.network_visible` (default false) + `network_visible_decided_at` + `messaging_preference` (everyone/connections/nobody, default connections) and the rule-45 BEFORE INSERT/UPDATE trigger (`service_bot_accounts`/`notification_test_actors`/`platform_only_accounts`). Also revokes client INSERT/UPDATE on `connection_requests` and adds SECURITY DEFINER `request_connection()`/`respond_connection()` (caller bound to `auth.uid()`, only recipient sets `accepted`, network request requires `network_visible` + preference ≠ nobody + no block + rate limit, free-text `message` capped and dropped for network). **The platform MIGRATION-QUEUE row + drift-baseline are a platform-side follow-up, not this v1 PR** — note the queue position in the PR body. Kiro never applies — Claude via RUN-MIGRATION.

§7a rules apply. Work only inside the allowed paths.

Branch `kiro/mt-network/network-visibility-db`; PR title `VTID-xxxxx (mt-network/network-visibility-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/network-visibility-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `hotmail`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Migration range `20261101051000`–`20261101051959`. Held until the VTID is allocated.
### 2026-10-18T19:40Z · kiro-hotmail-202610151618-b437 · replan (s2-round-1 R1-F5)
Reassigned to vitana-v1 (both tables are v1) and absorbed the `connection_requests` RPCs/revokes that were in `messaging-send-db` (also a v1 table). Seat `hotmail`→`exafyltd`, reviewer `jtadic`→`hotmail`; dropped platform-only paths; pgTAP now `supabase/tests/`. Queue row is a platform follow-up.
