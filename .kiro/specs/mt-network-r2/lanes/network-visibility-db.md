---
lane: network-visibility-db
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102051***_*.sql
  - supabase/tests/mt-network-visibility-db.pgtap.sql
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-platform]
---
# mt-network-r2/network-visibility-db — network_visible + connection RPCs (repo vitana-platform (one tree per object, re-plan R1-F1))

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `network-visibility-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7): migration + rollback + read-only pre/post checks in the PR; own `docs/validation/<vtid>/`. Adds `global_community_profiles.network_visible` (default false) + `network_visible_decided_at` + `messaging_preference` (everyone/connections/nobody, default connections) and the rule-45 BEFORE INSERT/UPDATE trigger (`service_bot_accounts`/`notification_test_actors`/`platform_only_accounts`). Also revokes client INSERT/UPDATE on `connection_requests` and adds SECURITY DEFINER `request_connection()`/`respond_connection()` (caller bound to `auth.uid()`, only recipient sets `accepted`, network request requires `network_visible` + preference ≠ nobody + no block + rate limit, free-text `message` capped and dropped for network). **The platform MIGRATION-QUEUE row + drift-baseline are a platform-side follow-up, not this v1 PR** — note the queue position in the PR body. Applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d).

§7a rules apply. Work only inside the allowed paths.

Branch `kiro/mt-network-r2/network-visibility-db`; PR title `VTID-xxxxx (mt-network-r2/network-visibility-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/network-visibility-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `hotmail`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/network-visibility-db`. Moved to the vitana-platform migration tree (one tree per object, R1-F1), seat `hotmail`. Versions day-shifted to `20261102050*`. Reviewer agent.
