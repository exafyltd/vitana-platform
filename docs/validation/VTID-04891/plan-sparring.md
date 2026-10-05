# VTID-04891 — plan sparring record

Change class: standard. Partner: independent read-only reviewer (plan-sparring-partner instructions). Rounds: 3.
Plan hash (sha256 of the text between the plan markers): `f90fb276c200c7d2d2ea13a8748a0427a49418353f363d3d363706b7efbe180e`

Verdict: ESCALATED. All technical findings closed (F1–F4). F5 (VTID allocated before sparring, rule 51) acknowledged; owner decision required.

<!-- plan:begin -->
## Problem
`ALERT-APP-USERS-IDENTITY-DRIFT.yml` step "Query Supabase app_users count (PostgREST)"
requests `${SUPABASE_URL}/rest/v1/app_users?select=id` with `Prefer: count=exact`,
`Range: 0-0`, and parses the `Content-Range` header. `public.app_users` has no `id` column
(primary key is `user_id`, no `id` column; bootstrap migration `20251231000000_vtid_01101_phase_a_bootstrap.sql:57-63`, confirmed by a live read-only `information_schema` query on 2026-10-05), so PostgREST answers
400 without `Content-Range`. The step runs under `set -euo pipefail`; the
`grep -i '^content-range:'` in the `COUNT=$(...)` pipeline exits 1, which kills the step
before its own "Could not parse Content-Range" error prints. Run 37293923892 (2026-10-05) failed
exactly this way with no message. The step never ran before because the Aurora step failed
first every day (Aurora stopped, then rebuilt, then Data API off, then IAM; all fixed today).

## Change
1. `select=id` -> `select=user_id`.
2. Make the header grep non-fatal (`(… | grep … || true)`) so a missing header reaches the
   existing `::error::` branch, which prints the response headers.
3. Guard the parsed value numerically (`if ! [[ "$COUNT" =~ ^[0-9]+$ ]]`) so a header without `/N` also reaches the error branch instead of failing later in the evaluate step's arithmetic.
4. No change to the Aurora step, the threshold, the evaluate step, or the schedule.

## Verification
- Jest pin test (new per-VTID file, header points at sibling `vtid-04787-self-audit-and-identity-drift.test.ts`): the workflow queries `app_users?select=user_id`, never `select=id`; the
  header grep is guarded by `|| true`; the numeric guard is present.
- Before merge, by hand from the session (one read-only GET each with the public anon key, not a
  suite; CLAUDE.md rule 48): `select=id` returns 400 "column does not exist"; `select=user_id`
  returns 2xx with `Content-Range: */0` (RLS hides rows from anon) or a permission error. The
  233 count is checked only post-merge by the workflow's own service-role call.
- After merge: dispatch the workflow on main; expect success with Aurora 233 / Supabase 233
  (both counts measured read-only on 2026-10-05).
- staging-tests.json: the jest pin (workflow-only change, nothing deploys to staging).
<!-- plan:end -->

## Planner responses (round 1)
- F1 ACCEPTED. The list came from a live information_schema read truncated at 6 rows; replaced with the PK/no-id statement and its source.
- F2 ACCEPTED. Expected anon results stated exactly; the 233 check stays post-merge (service role).
- F3 ACCEPTED. Numeric guard added to the plan and to the pin test.
- F4 ACCEPTED. A new per-VTID file, as the repo convention requires; its header references the sibling file. staging-tests.json follows the VTID-04787 template.
- Q1: a live Supabase read (truncated). Aurora shape is out of scope; this check counts rows only.
- Q2: yes. The dispatch result is recorded in docs/validation/<VTID>/outputs/.
- Q3: yes, by hand from the session, read-only GETs with the anon key.

## Round 3 partner verdict
F1–F4 closed. F5 acknowledged, not closable by planner or partner: VTID-04891 was allocated before the sparring (gate exception for the owner). No new findings. ESCALATED.
