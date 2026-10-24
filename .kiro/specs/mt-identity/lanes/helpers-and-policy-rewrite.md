---
lane: helpers-and-policy-rewrite
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: exafy
paths:
  - supabase/migrations/20261101030000_vtid_xxxxx_tenant_id_for_policies_is_member.sql
  - supabase/migrations/20261101030100_vtid_xxxxx_bare_policy_rewrite.sql
  - supabase/migrations/20261101030100_vtid_xxxxx_bare_policy_rewrite_rollback.sql
  - scripts/ci/bare-policy-lint.mjs
  - services/gateway/test/mt-identity-bare-policy-lint.test.ts
updated: 2026-11-01T00:00Z
---
# helpers-and-policy-rewrite — tenant_id_for_policies() + is_member() + the bare-policy rewrite (DB)

Plan: `.kiro/specs/mt-identity/plan.md` (authoritative), `tasks.md` group `<!-- lane: helpers-and-policy-rewrite -->`.
Design and successor rules: `design.md`.

**Held:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID; it then flips to `kiro` and the executor
claims it. VTID is substituted into the migration file names and front matter at allocation time.

Scope: the N3 ordering gate. Ship `tenant_id_for_policies()` (new name, NOT a redefine of `current_tenant_id()`) and
`is_member(tenant_id)` as a STABLE SECURITY DEFINER helper pair over the unique `(tenant_id, user_id)` index with the
N2 degraded-path `coalesce(<claim, if is_member>, <auth.uid()'s primary user_tenants row>)`; rewrite every bare
`tenant_id = current_tenant_id()` policy (recounted this review: 19 bare policies on 11 tables — community_groups,
community_meetups, community_listings, d42_domain_weights, event_attendance, live_highlights, live_room_attendance,
live_rooms, products_catalog, services_catalog, tenant_catalog_overrides) to `user_id = auth.uid() AND tenant_id =
(select tenant_id_for_policies())` (user-private) or `(select is_member(tenant_id))` (tenant-shared); add the
WS0-style bare-policy lint that must read ZERO. Re-run the recount at implementation and record the exact set in the
PR. Do NOT create or relax policies on the 5 named tables with no policy (access_audit_log, consents,
retrieval_traces, role_sessions, user_roles) — WS2/WS10, out of scope. This lane does NOT redefine
`current_tenant_id()` and does NOT enable the hook.

§7a: no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/dispatch, no Supabase/AWS
write. A DB change is a migration file in this PR; Claude applies it via RUN-MIGRATION after merge. Add the lane's
`docs/validation/<vtid>/` (rollback, read-only pre/post checks, MIGRATION-QUEUE row) in this PR.
Branch `kiro/mt-identity/helpers-and-policy-rewrite`; PR title `VTID-xxxxx (mt-identity/helpers-and-policy-rewrite): …`;
commit trailers `Collab-Session: <kiro id>` + `Collab-Lane: mt-identity/helpers-and-policy-rewrite`.

## Log
### 2026-11-01T00:00Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-identity planner. Held at `next_actor: owner` pending PLAN-SPAR VTID allocation.
