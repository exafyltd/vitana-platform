---
lane: helpers-and-policy-rewrite
state: ready
next_actor: kiro
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
depends_on: []
paths:
  - supabase/migrations/20261102030000_vtid_*_tenant_id_for_policies_is_member.sql
  - supabase/migrations/20261102030100_vtid_*_bare_policy_rewrite.sql
  - supabase/migrations/20261102030100_vtid_*_bare_policy_rewrite_rollback.sql
  - scripts/ci/bare-policy-lint.mjs
  - services/gateway/test/mt-identity-bare-policy-lint.test.ts
  - supabase/tests/mt_identity_helpers_*.sql
updated: 2026-11-02T13:05Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05465
---
# helpers-and-policy-rewrite — tenant_id_for_policies() + is_member() + the bare-policy rewrite (DB)

Plan: `.kiro/specs/mt-identity-r2/plan.md` (authoritative) and the `helpers-and-policy-rewrite` group of `tasks.md`
(H1–H4, allowed paths, acceptance). Design: `design.md`. The VTID comes from PLAN-SPAR on convergence, never by hand.

Scope: the N3 ordering gate.
- Ship `tenant_id_for_policies()` and `is_member(tenant_id)` as a STABLE SECURITY DEFINER pair over the unique
  `(tenant_id, user_id)` index, with the N2 degraded path. `tenant_id_for_policies()` is a new name, not a redefine
  of `current_tenant_id()`.
- Rewrite every bare `tenant_id = current_tenant_id()` policy. The recount on 2026-11-01 found 32 policies on 15
  tables, including `match_targets`, `relationship_nodes`, `social_alignment_signals` and `topic_registry`, which
  the old count missed.
  - A table with a `user_id` owner column is user-private; any other table is tenant-shared (`is_member`).
  - Keep the extra predicates of `community_listings_select_public` and `d42_domain_weights_select`.
  - Keep today's write audience (any member of the tenant).
- Add the bare-policy lint; it must read ZERO.
- Re-run the recount at implementation and record the set, the classification and the column evidence in the PR.
- No policy on the 5 no-policy tables.
- This lane does not redefine `current_tenant_id()` and does not enable the hook.

Rules (`collaboration.md` §7a):
- No VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge outside §7b, and no Supabase or AWS write.
- A DB change is a migration file in this PR. After merge, Kiro applies it through `RUN-MIGRATION.yml` only on the
  owner's approval of the files and the target database (§7d).
- Branch `kiro/mt-identity-r2/helpers-and-policy-rewrite`. PR title
  `VTID-xxxxx (mt-identity-r2/helpers-and-policy-rewrite): …`. Trailers `Collab-Session` +
  `Collab-Lane: mt-identity-r2/helpers-and-policy-rewrite`.

## Log
### 2026-11-01T15:00Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-identity/helpers-and-policy-rewrite`. The bare-policy set was re-counted on `62990ce285` (32 on 15
tables). Executor and reviewer follow today's §3a and §7 rules.

### 2026-11-02T13:05Z · ci-plan-spar · ready (VTID allocated)
VTID-05465 allocated after policy approval (converged-auto-v1).

### 2026-11-02T17:50Z · agent-vitana-lane-reviewer-202611021750-55cc · review
review: changes
head: 28232f2bb7c2271aac8ec357059a0b3722b19b90
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4625
Findings:
- [blocking] supabase/migrations/20261102030100_vtid_05465_bare_policy_rewrite.sql:55. The diff matches amendment 1 exactly (32 policies on tenant_id = (select public.tenant_id_for_policies()), extra predicates kept, no user_id term, no is_member() in a policy), but its premise rests on migration text only. MULTI-TENANT-PLAN.md:24 (verified 2026-10-06), DATABASE_SCHEMA.md:3320-3322 and :3646-3647, and CHANGELOG.md:30 say the live current_tenant_id() returns NULL for browser JWTs and the 20260218 fix was never applied live. If so, the rewrite turns no browser access into every-tenant-member access (attendance reads, writes on groups, meetups, live rooms, catalogs). AC-4 and AC-5, proven on a fixture with the 20260218 body, cannot show it. Add a live-body guard in the DO $pre$ block, print the markers in pre-check.sql:64, test the guard red on this head, and correct acceptance.md (:31, :34, :63, :121-122). If the old body is live, park the lane for a plan decision before any apply.
- [non-blocking] docs/validation/VTID-05465/acceptance.md:122. tenant_id_for_policies() ignores request.tenant_id, the 'tenant' claim and app_metadata.active_tenant_id, so multi-tenant members with a non-primary active tenant, and callers whose app_metadata tenant has no user_tenants row, resolve differently after the rewrite. It cannot widen to a non-member tenant, but it is not 'no visible change'. Add a read-only count of both groups to pre-check.sql before the apply request.
- [non-blocking] docs/validation/VTID-05465/acceptance.md:43. AC-8 is partly met: PGlite with a pgTAP shim, not the D11 stack with real pgTAP, and no CI runner for the pgTAP files. Run on the D11 stack or real pgTAP, or record the owner's waiver, before the apply approval is requested.
- [non-blocking] docs/validation/VTID-05465/post-check.sql:10. Check 2 (0 rows on all public tables) can return live bare policies this lane leaves alone, and check 3 (32 rows) ignores skipped absent tables. Scope check 2 to the 32 rewrite-set policies and derive check 3's count from pre-check 1.
- [non-blocking] services/gateway/test/mt-identity-bare-policy-lint.test.ts. Gateway Jest shards 1-4, oasis-projector, vcaop and openclaw-bridge are still queued, and the 16 completed checks are green. I could not confirm the earlier autopilot-event-loop failure from the evidence. The land step waits for the shards on the final head.
Next: the lane's seat fixes the blocking finding and asks for review of the new head. If the guard shows the 20251229 body is live, the seat parks the lane with the five-part stop message for a plan decision on amendment 1. The amendment 1 conformance, the acceptance mapping (AC-1 to AC-11) and the red-on-base evidence (Jest 7/7 red alone, 4 red and 3 green with the lint script, 4 structural pgTAP reds on main's policies) need no rework.
