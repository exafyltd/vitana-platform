---
lane: messaging-send-db
state: done
next_actor: kiro
depends_on: [network-visibility-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102050***_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-network-messaging-send-db.pgtap.test.ts
updated: 2026-11-07T18:17Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05576
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-network-r2/messaging-send-db
pr: https://github.com/exafyltd/vitana-platform/pull/4832
---
# mt-network-r2/messaging-send-db — scope column, send/connection RPCs, client-write revokes (repo vitana-platform)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `messaging-send-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7), **platform** `chat_messages` only: adds `chat_messages.scope` (expand/contract), **asserts the catch-all `service_role_manage_chat` policy stays gone (created `20260225200000_chat_messages.sql:35-38`, already DROPPED by `20260608120000_phase_a_security_hotfix.sql:25`; re-plan R1-F4) and replaces it with narrow SELECT + `read_at`-UPDATE policies** so a service-role client can no longer direct-INSERT arbitrary scope/tenant (R1-F3; SECURITY DEFINER RPCs bypass RLS as owner for INSERT), revokes the authenticated client INSERT on `chat_messages`, and creates `send_message()` + `send_message_as()`. **The `connection_requests` RPCs/revokes moved to `network-visibility-db` and the `global_messages` revoke to `legacy-messages-migration-db` — both are vitana-v1 tables (R1-F4/F5), not this platform lane.** Migration + rollback + read-only pre/post checks + MIGRATION-QUEUE row, all in this PR; own `docs/validation/<vtid>/`. Kiro never applies on its own — Kiro via RUN-MIGRATION, only on the owner's approval of the files and the target database (§7d), after merge.

§7a rules: no VTID allocation, no `_plan` claim, no edit of `handoff.md` or another lane file, no merge/approve/deploy/workflow dispatch, no Supabase/AWS writes. Depends on `network-visibility-db` — `send_message`'s network branch reads `global_community_profiles.network_visible`/`messaging_preference` and `connection_requests` state (all added by that v1 lane). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/messaging-send-db`; PR title `VTID-xxxxx (mt-network-r2/messaging-send-db): …`; commit trailers `Collab-Session: <your kiro session id>`, `Collab-Lane: mt-network-r2/messaging-send-db`. When the PR is open: `state: in-review`, `next_actor: kiro` (reviewer seat `jtadic`), `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/messaging-send-db`. Versions day-shifted to `20261102050*`. Reviewer agent.

### 2026-11-06T10:10Z · ci-plan-spar · ready (VTID allocated)
VTID-05576 allocated after policy approval (converged-auto-v1).

### 2026-11-07T16:00:00Z · agent-vitana-lane-reviewer-202611071600-4832 · review
review: accept
head: 9647397d6a68ae3d269370ba020f78ce6469fa87
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4832
Findings: non-blocking: (1) add a HOLD marker to MIGRATION-QUEUE row 47; (2) guard network->community laundering by service_role in send_message_as; (3) add coverage for case 58 in the pgTAP test.
Next: the land step merges under §7b

### 2026-11-07T18:13Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-network-r2/messaging-send-db; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T18:13Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4832. Reviewed on head `9647397d6a` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T18:13Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: afeb5b7a816d2630271e28e96ef72c0a4d64b645 (exafyltd/vitana-platform#4832)
authority: §7b PM rule. Squash merge by land-guard on head `c0568fbe81`: the reviewed head `9647397d6a` plus the review-entry commit. `land-guard review` ok, `land-guard checks` green, PR up to date. No lane code changed after the accept.
The migrations in this lane are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d). Next: STAGING-VERIFY on the merge commit, then the `done` record.

### 2026-11-07T18:17Z · kiro-hotmail-202611061752-cc1f · verified → done
This lane deploys nothing: it adds a migration file (20261102050*) with rollback, pgTAP test and MIGRATION-QUEUE rows, none applied. No staging deploy follows from the merge (afeb5b7a81), so there is no STAGING-VERIFY run for it; it is done at merge with green checks (26 green on head c0568fbe81). Applying the migration needs the owner's approval of the files and the target database (collaboration.md §7d). Non-blocking review notes carried forward: HOLD marker on MIGRATION-QUEUE row 47, guard against network->community laundering by service_role, case-58 coverage.
