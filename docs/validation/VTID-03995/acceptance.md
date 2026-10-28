# VTID-03995 — Role switching for automatically activated patients (get_my_permitted_roles ∪ memberships, community always reachable)

## Report

Found while building the mobile role switcher (`exafyltd/vitana-v1`
PR #1101, VTID-03993). The health-order trigger `trg_activate_patient_profile`
(VTID-03932, live since Phase A) bumps `memberships.role` community→patient
for the buyer — but the two RPCs the role switcher runs on never look there:

1. `get_my_permitted_roles()` reads ONLY `user_permitted_roles`, a plain base
   table (confirmed live via `pg_get_functiondef`, see
   `outputs/live-function-defs-before.txt`) that the trigger never writes. So
   the switcher never listed Patient for an automatically activated patient,
   on desktop or mobile.
2. `set_role_preference()`'s fallback path requires an active `memberships`
   row AND `validate_role_assignment()` — a grant-to-others predicate that
   always fails for an ordinary member. And because the trigger REPLACES the
   community row rather than adding one, such a member could switch neither
   to Patient nor back to Community.

Scope: one migration file,
`supabase/migrations/20260917100000_vtid_03995_role_switch_community_and_membership_roles.sql`,
replacing those two functions. **File-only until the platform owner applies
it** — the single shared Supabase project is read by staging and production
alike, so applying is a deliberate, separate step, exactly as with the
Phase B `commerce_vertical` migration. No gateway code, no route, no OASIS
event, no deploy.

## Acceptance Criteria

AC-1 — `get_my_permitted_roles()` returns explicit grants
(`user_permitted_roles`) ∪ roles held via an ACTIVE `memberships` row for the
current tenant ∪ `'community'`, ladder-ordered and restricted to the eight
known roles; the exafy-admin (all eight) and no-tenant (`['community']`)
branches are unchanged.

TEST: the new definition was diffed by hand against the live one
(`outputs/live-function-defs-before.txt`, read-only `pg_get_functiondef`):
same signature, `SECURITY DEFINER`, `SET search_path TO 'public'`, same
`current_tenant_id()`/`auth.users` lookups, same JSON envelope
`{ok, roles, is_super_admin}`; only the roles aggregation changes. The
frontend consumer (`vitana-v1/src/hooks/useMemberships.ts`) reads
`payload.roles` and is unaffected by ordering. Not executed against a
database from this session — see "Explicitly not covered".

AC-2 — `set_role_preference(p_tenant_id, p_role)` accepts `'community'` for
every authenticated caller; accepts any other role if `check_role_permitted`
holds OR an active `memberships` row carries it (no
`validate_role_assignment` on that path); still refuses `admin` for
non-exafy callers; still upserts `role_preferences` and writes the
`audit_events` row unchanged.

TEST: hand diff against the live definition (same file above): signature,
`SET search_path TO ''`, schema-qualified references, the admin block, the
upsert and the audit insert are byte-identical; only the permission
pre-check changes (community short-circuit; `validate_role_assignment`
removed from the memberships path). The frontend writer
(`vitana-v1/src/hooks/useRole.tsx` `setRole`) is unchanged.

AC-3 — Until the migration is applied, the frontend still offers Patient to
an activated patient: `vitana-v1` PR #1101's `useRoleSwitch` unions
`usePatientAccess().isPatient` into the list, so the mobile switcher does
not depend on this migration to SHOW the role — only the write path does.

TEST: `vitana-v1/src/hooks/useRoleSwitch.test.ts` ("adds patient from the
patient_profiles flag") — executed for real via a transpile-and-run harness
before PR #1101 was pushed (its PR body records the run).

## Explicitly not covered

No SQL was executed against any database from this session: this repo's
absolute rule forbids writes as the test account on any host, and there is
no isolated Supabase project for this. The migration is delivered as a file
for the owner to apply (`RUN-MIGRATION.yml` or the Supabase MCP
`apply_migration`), after which the first live confirmation is: sign in as
an activated patient, `select get_my_permitted_roles()` → roles include
`patient`; pick Patient in the switcher → `role_preferences.role = 'patient'`;
pick Community → back to `'community'` with no exception. No route is added
or removed (no `ROUTE_MOUNT:`/`FINAL_URL:`/`CURL_PROOF:`); no OASIS emission
is touched (`OASIS_IMPACT: no`); `DATABASE_SCHEMA.md` documents tables, not
these two functions, so it is unchanged.
