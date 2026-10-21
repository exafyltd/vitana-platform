# VTID-04655 — me_set_active_role writes role_preferences (one role truth)

Found by the VTID-04560 staging verification: `me_set_active_role('developer')`
answered `{ok:true, tenant_id:null}` and `role_preferences` stayed `community`,
because the function keyed the preference write on `current_tenant_id()`, which
never sees a tenant in a Supabase JWT (VTID-04044). One real user had already
drifted (switched to developer 2026-09-25 18:35, preference still community).

Fix: `supabase/migrations/20260926150000_vtid_04655_me_set_active_role_writes_role_preferences.sql`
— authorization unchanged; the preference tenant falls back to the token's
`app_metadata.active_tenant_id`, then the primary membership, members only; the
drifted row re-aligned to the newer choice. Applied live 2026-09-26 (Supabase
MCP, standing approval).

AC-1: the migration keeps authorization on `current_tenant_id()` + `check_role_permitted` and adds the member-only preference-tenant fallback.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-2 (live, verified): as the test user, `me_set_active_role('developer')` → `user_active_roles=developer`, `role_preferences=developer`, `preference_tenant_id=2e7528b8…`; restored to community/community.
