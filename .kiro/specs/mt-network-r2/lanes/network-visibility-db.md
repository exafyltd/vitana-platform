---
lane: network-visibility-db
state: done
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102051***_*.sql
  - supabase/tests/mt-network-visibility-db.pgtap.sql
updated: 2026-11-07T13:59Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05582
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-network-r2/network-visibility-db
pr: https://github.com/exafyltd/vitana-platform/pull/4798
---
# mt-network-r2/network-visibility-db — network_visible + connection RPCs (repo vitana-platform (one tree per object, re-plan R1-F1))

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `network-visibility-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7): migration + rollback + read-only pre/post checks in the PR; own `docs/validation/<vtid>/`. Adds `global_community_profiles.network_visible` (default false) + `network_visible_decided_at` + `messaging_preference` (everyone/connections/nobody, default connections) and the rule-45 BEFORE INSERT/UPDATE trigger (`service_bot_accounts`/`notification_test_actors`/`platform_only_accounts`). Also revokes client INSERT/UPDATE on `connection_requests` and adds SECURITY DEFINER `request_connection()`/`respond_connection()` (caller bound to `auth.uid()`, only recipient sets `accepted`, network request requires `network_visible` + preference ≠ nobody + no block + rate limit, free-text `message` capped and dropped for network). **The platform MIGRATION-QUEUE row + drift-baseline are a platform-side follow-up, not this v1 PR** — note the queue position in the PR body. Applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d).

§7a rules apply. Work only inside the allowed paths.

Branch `kiro/mt-network-r2/network-visibility-db`; PR title `VTID-xxxxx (mt-network-r2/network-visibility-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/network-visibility-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `hotmail`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/network-visibility-db`. Moved to the vitana-platform migration tree (one tree per object, R1-F1), seat `hotmail`. Versions day-shifted to `20261102050*`. Reviewer agent.

### 2026-11-06T10:10Z · ci-plan-spar · ready (VTID allocated)
VTID-05582 allocated after policy approval (converged-auto-v1).

### 2026-11-07T13:45:00Z · agent-vitana-lane-reviewer-202611071337-6bb5 · review
review: accept
head: 4a76ead299ea3e0fd12f7578e343d5af0c9abce7
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4798
Findings: non-blocking: aurora-cutover-restore-grants.sql:1664,3058 re-grants INSERT/UPDATE on replay (Aurora cutover lane must drop them); late-listed excluded account not flipped back until next profile write (documented); no client writer of connection_requests found in vitana-v1 src, supabase/functions or gateway src (local v1 checkout may be behind its main); CI 11/11 green is the caller's report, not read by the reviewer; queue rows and drift baseline follow in the platform follow-up per tasks.md task 4.
Next: the land step merges under §7b (migration is not applied; applying needs the owner's approval of the files and target database, §7d)

### 2026-11-07T13:54Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-network-r2/network-visibility-db; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T13:54Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4798. Reviewed on head `4a76ead299` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T13:54Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: a5d793aa6975464176a0f0adad244d652958a449 (exafyltd/vitana-platform#4798)
authority: §7b PM rule. Squash merge by land-guard on head `a90f2c6a2f`: the reviewed head `4a76ead299` plus the review-entry commit. `land-guard review` ok, `land-guard checks` green, PR up to date. No lane code changed after the accept.
The migrations in this lane are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d). Next: STAGING-VERIFY on the merge commit, then the `done` record.

### 2026-11-07T13:59Z · kiro-hotmail-202611061752-cc1f · verified → done
Closing record: merge a5d793aa6975464176a0f0adad244d652958a449 (#4798) changes no path under services/gateway or the stage deploy workflow (supabase migrations, tests, docs and the drift baseline only), so AWS-STAGE-DEPLOY-GATEWAY and STAGING-VERIFY did not run for it: this change deploys nothing. It is done at merge with green checks (12/12 on the final head). The migration of this lane is on main and NOT applied; applying it needs the owner's approval per file and database (collaboration.md §7d). The queue rows and the drift baseline follow in the platform follow-up (tasks.md task 4). The lane claim is released once this record is on main.
