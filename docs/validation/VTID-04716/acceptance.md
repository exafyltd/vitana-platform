# VTID-04716 — Five features get the data layer they never had

VTID: VTID-04716
VALIDATION_PROFILE: gateway_backend

Companion VTIDs, shipped in this PR:
- VTID-04717 Risk Mitigation (D49)
- VTID-04718 Overload Detection (D51) and `caller_tenant_id()`
- VTID-04719 Taste Alignment (D39)
- VTID-04720 User Preferences (preference modeling)

## Problem
Service Health (VTID-04665) showed five features down. Checked live on 2026-09-28, none of their
tables or functions existed. The original migrations had never applied, and running them locally
shows why:

| Feature | Why it never existed |
|---|---|
| Autopilot Prompts | FK to `tenants(id)`; the live key is `tenants(tenant_id)` |
| Risk Mitigation | no migration was ever written; only a notification trigger guarded on the table's existence |
| Overload Detection | an index on `overload_patterns.created_at` before the column existed |
| Taste Alignment | never applied; the audit function also fails at runtime (ORDER BY on an aggregate) |
| User Preferences | its table `user_preferences` collides with the live per-user settings table; same audit bug |

A further problem blocked all three tenant-scoped features: their functions resolved the tenant via
`current_tenant_id()`, which returns NULL for a Supabase JWT (the tenant is in
`app_metadata.active_tenant_id`). So even an applied schema would have answered `TENANT_NOT_FOUND`
to every member.

## Change
Five idempotent migrations:
- `20260928200000_vtid_04716_autopilot_prompts_data_layer.sql`
  - FK corrected to `tenants(tenant_id)`.
  - The two any-user SECURITY DEFINER helpers are now `service_role` only; they were granted to every
    member.
- `20260928200100_vtid_04718_overload_detection_data_layer.sql`
  - New `caller_tenant_id()`.
  - `created_at` declared in the table.
- `20260928200200_vtid_04719_taste_alignment_data_layer.sql`
  - Uses `caller_tenant_id()`.
  - Audit pagination moved into a subquery.
- `20260928200300_vtid_04720_preference_modeling_data_layer.sql`
  - The explicit-preference table is `user_explicit_preferences`; `public.user_preferences` is not touched.
  - Uses `caller_tenant_id()`, with the same audit fix.
- `20260928200400_vtid_04717_risk_mitigations.sql`
  - A new table built from what the engine writes.
  - Owner-only RLS; inserts are allowed only into the member's own tenant.
  - The member-facing notification trigger is deliberately left detached.

Code change: `routes/user-preferences.ts` health now declares `user_explicit_preferences`.

`current_tenant_id()` is **not** changed.

## Verification before apply
Postgres 16 with Supabase stubs (`outputs/supabase-stub.sql`):
- All five migrations applied twice without an error (`outputs/apply-twice.txt`).
- Every function the services call was run as an authenticated member (`outputs/member-smoke.*`):
  preferences set/update/bundle/audit, constraint, taste get/set/react/bundle/audit, lifestyle, all
  overload functions, prompt prefs/count as the service role, risk insert/dismiss.
- RLS rejected a risk row written for another user and a risk row from a member with no tenant.
- A second member saw zero rows in each table.

## Acceptance criteria
AC-1: The migrations use the live tenant key, never touch `user_preferences` or redefine
`current_tenant_id()`, and route tenant resolution through `caller_tenant_id()`. `risk_mitigations`
has every column the engine writes, owner-only RLS and no notification trigger. The audit functions
paginate in a subquery. The user-preferences health route declares the new table.
TEST: services/gateway/test/vtid-04716-feature-data-layers.test.ts

AC-2: The dependency-probe contract still holds with the renamed table.
TEST: services/gateway/test/vtid-04665-dependency-probe.test.ts

AC-3 (staging): after the migrations are applied and the commit is deployed, all five health routes
report `ok: true` (each route keeps its own status word, e.g. `healthy`) (`staging-tests.json`).

## Applied live (2026-09-28)
`RUN-MIGRATION.yml` could not be used: its `SUPABASE_ACCESS_TOKEN` returns `401 Unauthorized`
(run 36481329017), which is an owner item. The five migrations were applied through the Supabase MCP.
Each file was stripped of comment-only lines, and the stripped copy was first applied to a fresh
local database without an error.

`outputs/live-function-md5.txt`: all 28 function bodies live are byte-identical to that tested copy.

All 18 tables exist with RLS on. `public.user_preferences` is unchanged (36 columns, 230 rows), and
`trg_notify_risk_mitigation` is not attached.

On staging, before this code deployed, 4 of 5 health routes already read `ok: true, status: healthy`.

## Security advisor
After the apply, the Supabase security advisor flagged two things on the new objects:
- 25 SECURITY DEFINER functions were executable by `anon` (Supabase's default grant);
- `is_in_quiet_hours` had a mutable `search_path`.

`20260928200500` revokes `anon`/`PUBLIC` EXECUTE and pins the path. It was applied twice locally, then
live. Live result: 0 of 28 executable by anon, 26 by members, and the two prompt helpers are
`service_role` only.

## Not done here
- `matches_daily` (VTID-01088) does not exist, so Autopilot Prompts has its tables but no source of
  matches yet.
- Attaching `trg_notify_risk_mitigation` would push to real members; that is the owner's call.
