# VTID-04891 — identity-drift check counts Supabase app_users by user_id

VTID: VTID-04891
VALIDATION_PROFILE: gateway_backend

## Problem
`ALERT-APP-USERS-IDENTITY-DRIFT.yml`'s Supabase step requested `app_users?select=id`.
`app_users` has no `id` column (PK `user_id`), so PostgREST answered 400 with no
`Content-Range`, and the header `grep` killed the step under `set -euo pipefail` before its
own error printed (run 37293923892, 2026-10-05). The step had never run before: the Aurora
step failed first every day (cluster stopped, then rebuilt 1–2 Oct, then Data API off, then
the workflow's IAM user lacked the secret; the last two were fixed on 2026-10-05).

## Change
- `select=id` → `select=user_id`.
- Header grep guarded with `|| true`; the count must match `^[0-9]+$`, otherwise the existing
  `::error::` branch prints the response headers.
- Aurora step, threshold, evaluate step and schedule unchanged.

## Acceptance criteria
AC-1: the workflow counts by `user_id`, a missing or non-numeric Content-Range reaches the error
branch, and the threshold and Aurora skip are unchanged.
TEST: services/gateway/test/vtid-04891-identity-drift-supabase-count.test.ts

AC-2 (live, read-only, by hand): with the public key `select=id` → 400 `column app_users.id does not exist`;
`select=user_id` → 200 `content-range: */0` (RLS hides rows from anon).
CURL: GET https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/app_users?select=user_id (Prefer: count=exact) -> 200 with Content-Range

AC-3 (after merge): a workflow_dispatch of ALERT-APP-USERS-IDENTITY-DRIFT on main succeeds;
Aurora 233 / Supabase 233 measured read-only on 2026-10-05.
CURL: GET https://api.github.com/repos/exafyltd/vitana-platform/actions/workflows/ALERT-APP-USERS-IDENTITY-DRIFT.yml/runs -> latest workflow_dispatch on main: success
