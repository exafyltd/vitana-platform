# VTID-03832 — Auth: `backoffice` role + `vitana_role`/`tenant_role` enum alignment

## Report

Decision 4/4b/7 of the BackOffice plan (docs/backoffice/GOLDEN-WORKFLOWS.md,
VTID-03831): a first-class `backoffice` role on the linear ladder between
`staff` and `admin`, and the latent `infra` enum gap closed at the same time.
Three layers, all of which the live database (read-only, 2026-09-12) showed
had to be threaded:

| Layer | Live state found | Change in this PR |
|---|---|---|
| enum `public.vitana_role` (role_sessions.active_role, user_roles.role, `set_active_role()` cast) | 6 values, **no `infra`** — grantable but never activatable | `20260913000000_*`: `ADD VALUE 'infra'`, `'backoffice'` (own file, ADD VALUE transaction rule) |
| enum `public.tenant_role` (memberships.role, what `set_role_preference()` validates) | 6 values incl. legacy `reseller`, no developer/infra | `20260913000001_*`: `ADD VALUE 'backoffice'`, `'developer'`, `'infra'` |
| RPCs `get_my_permitted_roles()`, `me_set_active_role()`, `validate_role_assignment()`, `set_role_preference()` | the last two existed **only live** — no definition in this repo | `20260913000002_*`: CREATE OR REPLACE of the live bodies with the marked VTID-03832 lines |
| gateway `VALID_ROLES` ×5 (`me.ts`, `role-admin.ts`, `admin-users.ts`, `dev-auth.ts`, `admin-navigator.ts`) | 7 roles hand-copied five times | one shared `src/constants/vitana-roles.ts`; `backoffice` tenant-admin-grantable, developer/infra stay super-admin-only |
| frontend (`exafyltd/vitana-v1`, companion PR) | `UserRole` union + `ROLE_HIERARCHY` (7), drawer labels/redirect, three routing switches, route enforcement, RolesAccess/Directory lists, i18n | `backoffice: 5, admin: 6, developer: 7, infra: 8`; `/backoffice/dashboard` redirect; `/backoffice` enforced like `/admin`; labels in 11 locales |

**Switch-path decision (the brief asked for it to be decided and documented):**
`set_role_preference()` is aligned to `user_permitted_roles` — the store
VTID-01230 declared canonical and the one the gateway's grant endpoint writes
to — via the existing `check_role_permitted()` predicate. The pre-existing
`memberships` + `validate_role_assignment()` path is kept as the second
accepted path, so nobody who can switch today loses that. The gateway grant
does NOT additionally create a `memberships` row. The hard block on non-Exafy
users switching to `admin` is unchanged.

**The migrations are NOT applied** (execution-brief rule 4: applying DDL to
the single Supabase project needs the owner's explicit "apply now" in
conversation). Everything below that says "verified" was verified on a
throwaway local Postgres 16 with the live enum values and minimal stubs, not
on the live project. The staging step "grant `backoffice` to the test user
and switch into it" is therefore also NOT done — it cannot succeed until the
enum exists.

## Acceptance Criteria

AC-1 — The three migration files apply in order on a Postgres 16 database
seeded with the live enum values, and afterwards `vitana_role` contains
`infra` and `backoffice`, `tenant_role` contains `backoffice`, `developer`,
`infra`.

TEST: `outputs/migration-scratch-pg16.txt` — "APPLIED 2026091300000{0,1,2}_…"
and the two `enum_range` rows. (Local throwaway cluster; not the live
project.)

AC-2 — A non-Exafy user granted `backoffice` only in `user_permitted_roles`
(the gateway grant path) sees it in `get_my_permitted_roles()` and can switch
into it via `set_role_preference()`; `role_preferences.role` becomes
`backoffice`.

TEST: `outputs/migration-scratch-pg16.txt` T1 (`"roles": ["backoffice"]`)
and T2 (`role = backoffice` after the call).

AC-3 — A role granted nowhere is still rejected, and the hard block on
non-Exafy users switching to `admin` still fires even when `admin` is in
`user_permitted_roles`.

TEST: `outputs/migration-scratch-pg16.txt` T3 (`Role not granted…` RAISE)
and T4 (`Admin role can only be assigned by super administrators` RAISE).

AC-4 — `me_set_active_role('backoffice')` and `set_active_role('backoffice')`
(the enum-cast path that could never activate `infra` before) both succeed
for a permitted user; an unpermitted role on the cast path returns
`ROLE_NOT_GRANTED`, not an enum error.

TEST: `outputs/migration-scratch-pg16.txt` T5 (`ok: true, active_role:
backoffice`) and T6 (`ok: true` for backoffice; `ROLE_NOT_GRANTED` for
infra — the cast itself now succeeds).

AC-5 — `validate_role_assignment()` ladder: a tenant `admin` may assign
`backoffice`; may NOT assign `developer`; `staff` may NOT assign
`backoffice`.

TEST: `outputs/migration-scratch-pg16.txt` T7 (`t` / `f` / `f`).

AC-6 — The gateway has exactly one role list: every route file imports it,
no route file still carries a hard-coded 7-role array, `backoffice` is not
in `SUPER_ADMIN_ONLY_ROLES`, the ranks are staff 4 / backoffice 5 / admin 6
/ developer 7 / infra 8, and the migration's arrays name the same eight
roles in the same order as the constant.

TEST: `test/vtid-03832-vitana-roles-constant.test.ts` (6 tests) +
`test/nav-catalog-role.test.ts` (updated to 8 roles) —
`outputs/gateway-jest-vtid-03832.txt`, 2 suites / 9 tests passed.

AC-7 — `tsc --noEmit` clean and no regression in the full gateway suite.

TEST: `outputs/gateway-tsc-noemit.txt` (exit 0);
`outputs/gateway-jest-full-tail.txt` (755/755 suites passed, 1 pre-existing
skip; 13,821 tests passed, 0 failures).

AC-8 — Frontend companion (`exafyltd/vitana-v1`): `ROLE_HIERARCHY` has eight
roles with `backoffice` strictly between `staff` and `admin`;
`hasPermission` semantics let admin/developer/infra through a `backoffice`
guard, keep `staff` out, and keep `backoffice` out of `admin`; `tsc` clean;
full vitest clean; the i18n ESLint rules clean on every changed file.

TEST: `src/hooks/useRole.hierarchy.test.ts` (3 tests) inside the full
`vitest run` — `outputs/frontend-checks-vitana-v1.txt` (tsc exit 0; 28
files / 182 tests passed; `npm run i18n:inventory` regenerated
`docs/SCREEN_INVENTORY.md`). The two ESLint errors in that log are
pre-existing `@typescript-eslint/no-explicit-any` hits on untouched lines
74/88 of RolesAccess.tsx (present on `origin/main`); with only that rule
muted the changed files lint clean, i18n rules included.

## Not verified / blocked

- Live application of the migrations, and the staging role-switch
  verification with the documented test user, are blocked on the owner's
  explicit "apply now" (rule 4). Until then `backoffice` exists in code and
  in the frontend switcher but cannot be granted or activated on staging.
- `/backoffice/dashboard` (the drawer's destination for the new role) is
  created by the next VTID (`/backoffice` skeleton); switching into the role
  before that lands hits the app's catch-all.
- The generated Supabase types file was edited by hand for the two enums; it
  should be regenerated once the migrations are applied.
