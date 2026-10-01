# VTID-04500 — Community Autopilot CA-2: role-scoped lineups

Step CA-2 of `docs/COMMUNITY-AUTOPILOT-V2-PLAN.md`. Frontend half:
`exafyltd/vitana-v1` (same VTID).

## What was wrong

- `queryRecommendationsByRole` applied **no filter** for `admin` or any unknown
  role. A signed-in member sending `?role=admin` (or any other value) received
  every user's personal suggestions.
- The routes trusted `?role=` / `X-Vitana-Active-Role` as sent. `?role=developer`
  on activate took the Dev Autopilot path (VTID allocation) for any member.
- With no role hint, a member got the legacy RPC view: their own items plus every
  system finding (`user_id IS NULL`, Dev Autopilot findings included).
- `role_scope` was `any` on every row; nothing set it.
- The frontend hard-coded `community`, so switching role never switched the lineup.

## What changed

- New `services/community-autopilot/lineup-role.ts`: `decideLineup` (pure) and
  `resolveLineupRole`. The hint is honoured for `community`/`patient`; a system
  role (`developer`/`admin`/`infra`) needs exafy_admin or
  `check_role_permitted(user, tenant, role)`, otherwise it narrows to the
  member's community lineup; `professional`/`staff`/`backoffice` get an empty
  lineup; unknown values never widen. No hint → the member's effective role
  (role_preferences, then user_tenants.active_role).
- All six routes that read the role resolve it through `resolveRequestRole`;
  only an exafy admin with no hint keeps the legacy RPC view (Command Hub).
- `queryRecommendationsByRole`: unknown roles return nothing; `admin`/`infra`
  get the system lineup, never everyone's personal rows.
- Migration `20260924180000_vtid_04500_autopilot_role_scope.sql` (applied live):
  backfill + BEFORE INSERT trigger. Live result: 7,905 community rows →
  `community`, 1,868 system rows → `developer`, 0 left at `any`.
- ORB opener reads `roleScopesVisibleFrom(active_role)`, so patient mode keeps
  seeing its community items after the backfill.

## Acceptance criteria

AC-1: A plain member sending `?role=admin` gets only their own community lineup (`user_id=eq.<self>` and `source_type=eq.community`), never every user's rows.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts

AC-2: A system role is honoured only when exafy_admin or `check_role_permitted` is true; otherwise it narrows to community. A member cannot reach the Dev Autopilot activation path with `?role=developer`.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts

AC-3: The same user switching role switches the lineup; a developer never maps to the personal community lineup; roles without a lineup get none; unknown values never widen.
TEST: services/gateway/test/vtid-04500-lineup-role.test.ts

AC-4: A plain member with no hint no longer gets the legacy all-system RPC view.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts

AC-5: Every existing row carries a real `role_scope` and new rows get one on insert (verified live after applying the migration: 0 rows at `any`).
TEST: docs/validation/VTID-04500/outputs/role-scope-live-counts.txt

AC-6: The new route tests fail against the unchanged source (5 of 80) and pass with it.
TEST: docs/validation/VTID-04500/outputs/mutation-src-reverted.txt

AC-7: The ORB opener asks for the scopes of the active role: community and patient read community rows, developer and admin read system findings only.
TEST: services/gateway/test/vtid-04500-opening-role-scopes.test.ts

## Not verified

No request was made against any live gateway. Frontend verified by vitest and lint.
