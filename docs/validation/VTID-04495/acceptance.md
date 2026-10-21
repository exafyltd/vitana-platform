# VTID-04495: memory rows are never scoped to the JWT role

Found while verifying the memory work on staging (2026-09-24): an ORB
navigation note written 12:49 UTC by the new staging gateway was stored with
`memory_items.active_role = 'authenticated'`.

## Root cause

VTID-04367 scoped ORB turn rows with `session.active_role ||
session.identity.role`. `identity.role` is the Supabase JWT `role` claim,
'authenticated' for every signed-in user. `memoryRoleForWrite()` treated it
as a work role, so the row was stored under a role nobody reads as, and
personal recall (`active_role IS NULL`) no longer saw it. `navigator-consult`
passes `identity.role` into memory too, which is how this row was written.

## Acceptance criteria

AC-1: database roles (authenticated, anon, service_role, supabase_admin) are stored as personal memory (NULL) and read as community.
TEST: services/gateway/test/vtid-04495-memory-role-not-jwt-role.test.ts

AC-2: real work roles still scope the row.
TEST: services/gateway/test/vtid-04495-memory-role-not-jwt-role.test.ts

AC-3: ORB recall sends no role or lens for the JWT role.
TEST: services/gateway/test/vtid-04495-memory-role-not-jwt-role.test.ts

AC-4: the ORB turn writers no longer fall back to `identity.role`.
TEST: services/gateway/test/vtid-04495-memory-role-not-jwt-role.test.ts

AC-5: the one affected row is repaired (active_role -> NULL). See commands.log.
TEST: services/gateway/test/vtid-04495-memory-role-not-jwt-role.test.ts (live SQL evidence in docs/validation/VTID-04495/commands.log)
