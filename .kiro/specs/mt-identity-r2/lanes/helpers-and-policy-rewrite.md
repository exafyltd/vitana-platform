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
updated: 2026-11-01T15:00Z
repos: [exafyltd/vitana-platform]
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
