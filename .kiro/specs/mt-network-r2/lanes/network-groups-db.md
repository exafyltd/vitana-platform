---
lane: network-groups-db
state: ready
next_actor: kiro
depends_on: [messaging-send-db, legacy-messages-migration-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102054***_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-network-groups-db.pgtap.test.ts
updated: 2026-11-06T10:10Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05579
---
# mt-network-r2/network-groups-db — chat_groups scope + add_group_member (M3, flagged) (repo vitana-platform)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `network-groups-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7): add `chat_groups.scope`/`chat_group_members.scope`, participant-only RLS, `add_group_member()` DEFINER (≤20, invite-only between connections, creator tenant as context, no system fan-out — D27). Rollback + pre/post checks + MIGRATION-QUEUE row (LAST) in this PR; own `docs/validation/<vtid>/`. Applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d).

§7a rules apply. Depends on `messaging-send-db` and `legacy-messages-migration-db` (legacy group threads already migrated into `chat_groups`). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/network-groups-db`; PR title `VTID-xxxxx (mt-network-r2/network-groups-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/network-groups-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/network-groups-db`. Versions day-shifted to `20261102050*`. Reviewer agent.

### 2026-11-06T10:10Z · ci-plan-spar · ready (VTID allocated)
VTID-05579 allocated after policy approval (converged-auto-v1).

### 2026-11-08T11:30Z · agent-vitana-lane-reviewer-202611081128-cd1d · review
review: accept
head: c8d6c78effcc19fb2de834221d969594ea79d793
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4850
Findings: none blocking. The blocking finding of the previous review on 394875b4f2 is fixed: add_group_member and add_group_member_as refuse every non-network group with 42501 not_network_group before the membership check; the community branch is removed; pgTAP cases 73-77 rewritten (red on the old head per red-community-old-head.txt, 92/92 green incl. double apply, jest 22/22), mutation M16 retargeted and caught. Non-blocking items addressed: the vitana.chat_group_rpc claim corrected (a guard, not authentication; tightening deferred), the 054200 non-SELECT-policy precondition added to live-before.sql. Standing rules hold: RLS with auth.uid(), tenant context, rules 43-45, SECURITY DEFINER lockdown, drift baseline 120 unchanged, MIGRATION-QUEUE rows 63-65 appended without altering existing rows. Non-blocking: check runs unreadable by the reviewer; the land step must confirm every required check green on this head.
Next: the land step merges under §7b
