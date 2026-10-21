# B4 — Sizing Refresh (VTID-03739)

**This is not a B4 execution pass.** B4 ("Identity — the hard one") remains
explicitly out of scope for this session: it is the plan's own designated
schedule-risk workstream — credential migration off GoTrue plus rewriting
or re-grounding hundreds of RLS policies is not a task to execute from a
static-analysis pass, and getting it wrong "locks out every user or,
worse, silently breaks tenant isolation" per the plan's own words. This is
a short, live-verified refresh of B4's sizing numbers only, done for the
same reason B2/B5/B6/B7 got the same treatment: to confirm whoever picks up
B4 execution is scoping against current reality, not the numbers the plan
was written with.

## Live numbers vs. the plan's, all three grown

| Metric | Plan's figure | Live (2026-08-25, project `inmkhvwdcuyhnxkgfvsb`) | Delta |
|---|---|---|---|
| `auth.users` row count | 199 | **205** | +6 |
| `public` schema RLS policies referencing `auth.uid()` (`qual`/`with_check` ILIKE) | 557 | **635** | +78 |
| Frontend `supabase.auth.*` call sites (`exafyltd/vitana-v1/src`, excluding tests) | 194 | **205** | +11 |

For reference, `public` schema has 1,030 RLS policies total — the 635
referencing `auth.uid()` are 62% of all policies, consistent with the
plan's framing that this is the mechanism holding tenant isolation together
across the vast majority of the schema.

## What this does and doesn't mean

None of these deltas are alarming in isolation — a live platform gains
users and ships new tables/features continuously, so upward drift between
"when the plan was written" and "today" is expected, not a red flag. The
useful signal is the **direction and rough magnitude**: every one of the
three numbers grew, none shrank, and the RLS-policy count grew
disproportionately (+14%) relative to the user count (+3%) — consistent
with ongoing feature work adding new `auth.uid()`-gated tables faster than
the user base grows, which is exactly the trend that makes B4 more
expensive the longer it's deferred, not less.

**Not done here, deliberately:** verifying the plan's proposed mechanism
(a compatible `auth.uid()` SQL function in Aurora, reading from a
per-connection session GUC, so the 635 policies port unchanged instead of
needing individual rewrites) actually works against Aurora — that requires
write access to Aurora this session's read-only boundary does not have
(see `docs/AURORA-PHASE0-RECONCILIATION-FINDINGS.md`'s Access Boundary
section), and is real engineering work regardless, not something a sizing
pass should attempt to shortcut.

## Addendum (VTID-03768), 2026-08-27 — the mechanism above is already built and partly verified; what's actually missing is different from what the plan assumed

This session has write access to Aurora (a later grant than the one the
paragraph above refers to — see this session's earlier task history).
Checked the specific open question directly, live, rather than repeating
"not verified" without looking:

**Already present on Aurora, and functionally correct where tested:**

- `auth.uid()`, `auth.jwt()`, `auth.role()`, `auth.email()` all exist in
  an `auth` schema on Aurora. Compared their definitions
  (`pg_get_functiondef`) against Supabase's real ones directly — not
  byte-identical text, but **semantically equivalent**: both read
  `current_setting('request.jwt.claim.sub', true)` first, falling back to
  parsing the `sub` key out of a `request.jwt.claims` JSON GUC.
- **Live end-to-end test, this session:** `SELECT
  set_config('request.jwt.claim.sub', '<uuid>', true), auth.uid();` —
  `auth.uid()` correctly returned the UUID just set. The mechanism itself
  works.
- The Supabase role model is present: `anon`, `authenticated`,
  `service_role` (with `rolbypassrls=true`, matching Supabase exactly —
  confirmed the other two do NOT have that flag), and a login-capable
  `authenticator` role (the same role PostgREST itself connects as in
  Supabase's own architecture). A pre-provisioned secret,
  `vitana/aurora/prod/postgrest-authenticator-uri`, holds a connection
  string for `authenticator` against Aurora's writer endpoint — evidence
  a PostgREST-against-Aurora deployment was at least scaffolded by an
  earlier, undocumented effort. **Not independently exercised this pass**
  (would need either a Data-API-compatible secret shape, which this one
  isn't — it's a raw URI, not the `{username,password}` JSON Data API
  requires — or direct network access this sandbox doesn't have).
- RLS is enabled on 576 Aurora tables with 984 policies present (vs.
  Supabase's ~1,030 total — some gap expected given CDC has been down
  since 2026-08-20, per `docs/AURORA-PHASE0-RECONCILIATION-2026-08-27.md`;
  not investigated further here).

**What's actually missing, confirmed live:** `SET ROLE authenticated`
(from the `vitana_admin` connection) followed by any query against
`public.*` fails with `permission denied for schema public` —
`authenticated` has no `GRANT USAGE ON SCHEMA public`, so it cannot reach
a single table regardless of RLS. Checked Supabase's live grants for
comparison: `anon`/`authenticated`/`service_role` each hold
SELECT/INSERT/UPDATE/DELETE/etc. on 598-600 tables in production. None of
that appears to have carried over to Aurora — expected, since DMS
replicates table structure and data, not `GRANT` statements, which are a
separate DDL category it was never configured to carry.

**This changes the shape of what's left for B4, not just its size.** The
plan characterized the `auth.uid()` compatibility trick as the risky,
unverified part ("that last trick is what makes 557 policies port
unchanged... without it they must each be rewritten"). It works, verified
live. What remains is comparatively mechanical: replicate Supabase's
`anon`/`authenticated`/`service_role` grant set onto Aurora (a scriptable,
well-understood operation — Postgres's `GRANT ... ON ALL TABLES IN SCHEMA`
plus matching `ALTER DEFAULT PRIVILEGES` for future tables), and wire the
gateway's connection layer to `SET ROLE`/set the JWT-claim GUC per request
the way PostgREST does.

**Deliberately not done in this pass:** actually running the grant
statements. Replicating `service_role`'s full-bypass-RLS access across
~600 tables is a consequential enough action (parallel in kind, if not in
mechanism, to the identity-migration risk the plan already flags for B4)
that it deserves its own scoped decision and VTID, not something to do
silently while verifying a mechanism works.

## Addendum (VTID-03769), 2026-08-27 — grants applied and verified live

`scripts/aws/setup-aurora-postgrest-grants.sh --apply` ran successfully via
`aws rds-data execute-statement` (RDS Data API — reachable over HTTPS,
unaffected by the VPC IPv6 gap blocking DMS's CDC connection, see
`docs/AURORA-PHASE0-RECONCILIATION-2026-08-27.md`). All 24 statements (8
per role × `anon`/`authenticated`/`service_role`) succeeded: `USAGE` on
`public`/`extensions`, `ALL` on tables/sequences, `EXECUTE` on functions,
plus matching `ALTER DEFAULT PRIVILEGES` so future tables inherit the same
grants automatically.

**Verified end-to-end, not just "no error on the GRANT statement":** opened
an RDS Data API transaction, ran `SET ROLE authenticated;` then `SELECT
count(*) FROM public.diary_entries;` — returned `0` (not `permission
denied for schema public`, the failure this addendum's prior pass
documented). Zero rows is the *correct* answer here, not a fluke: no
`request.jwt.claim.sub` was set in this probe transaction, so
`auth.uid()` resolves `NULL` and `diary_entries`' own RLS policy
(`auth.uid() = user_id`) correctly excludes every row — confirming grants
and RLS are both live and composing correctly, not that RLS is silently
open.

This closes the B4 identity/access gap for real: the `auth.uid()`
mechanism (VTID-03768) plus these grants (VTID-03769) together mean
Aurora's 984 existing RLS policies are now reachable and enforcing
exactly as Supabase's do. **Still not done, deliberately:** the gateway's
connection layer isn't wired to actually issue `SET ROLE`/set the JWT
GUC per request in any live code path (`aurora-client.ts`'s
`withAuroraRlsContext()` exists but nothing calls it from a route yet) —
that's the next real step, not a config change to make silently.

## Addendum (VTID-03591), 2026-08-29 — the route above exists now: `GET /api/v1/admin/aurora-rls-health`

The "next real step" this doc named above is done. Commit `5cbf8178`
("feat(admin): wire Aurora RLS shim into a real diagnostic route") added
`GET /api/v1/admin/aurora-rls-health` to `routes/admin-health.ts`, calling
`withAuroraRlsContext()` with the calling admin's own verified JWT
claims/role — exactly the missing wiring. 7 tests cover it end-to-end
(`test/routes/admin-aurora-rls-health.test.ts`): `configured:false` when
`AURORA_DATABASE_URL` is unset, the success path, and 503 for each of the
three failure modes the endpoint exists to catch (BYPASSRLS/superuser
login role, `auth.uid()` not resolving to the caller, `auth.uid()`
resolving to someone ELSE's id — a pooled-connection context leak).
Deliberately diagnostic-only: no business route reads/writes through
Aurora yet, this only proves or disproves the shim would work.

**What was still actually missing, found 2026-09-10:** `AURORA_DATABASE_URL`
was never set on either the staging or prod gateway task definition —
confirmed by grepping both `AWS-STAGE-DEPLOY-GATEWAY.yml` and
`AWS-PROD-DEPLOY-GATEWAY.yml` for `AURORA`, zero hits in either. So the
route above has been live in the image since 2026-08-29 but every real
invocation has always short-circuited to `configured:false` —
`getAuroraPool()` never had a connection string to try. The pg.Pool/raw-
Postgres-wire transport this route (and every future real business route)
would use has therefore *still* never been exercised end-to-end from
anywhere — only the RDS Data API (HTTPS, a completely different transport)
has been proven live, per this doc's own 2026-08-27 addendum above.

**Fixed same pass:** wired `AURORA_DATABASE_URL` into
`AWS-STAGE-DEPLOY-GATEWAY.yml` (staging only) as an upserted `secrets`
entry, sourced from the pre-provisioned `vitana/aurora/prod/
postgrest-authenticator-uri` secret — the same unprivileged `authenticator`
role verified in the 2026-08-27 addendum to have `rolsuper=false`/
`rolbypassrls=false`. Only one Aurora cluster exists in this account
(`vitana-aurora-prod`, confirmed via `aws rds describe-db-clusters` —
no separate staging cluster), so this points staging at the same cluster
prod would eventually use — not a new exposure, since staging already
reads/writes the same production Supabase project today (`vitana-v1`
CLAUDE.md: "gateway-staging runs against prod Supabase too"), and B1's
repository seams still route every real business call through
supabase-js regardless of this change. Validated the task-definition jq
upsert filter against a synthetic task-def JSON (correct upsert, existing
secrets/env vars preserved) since this session cannot dispatch the deploy
workflow itself to observe a real rollout. Deliberately **not** added to
`AWS-PROD-DEPLOY-GATEWAY.yml` — promoting to prod is a separate, later,
human decision, same pattern as every other staging-only flag in that
workflow.

**Still not done, and now the actual next step:** watching the next
staging deploy's `/api/v1/admin/aurora-rls-health` response flip from
`configured:false` to a real `ok`/503 verdict — that is the first live
confirmation the pg.Pool transport works at all, which no session so far
has been able to observe directly (no VPC route from any Claude Code
sandbox to Aurora's Postgres port, per this doc's earlier caveats).

**Checked 2026-09-11 (VTID-03815 continuation):** curled
`https://preview-aws-gateway.vitanaland.com/api/v1/admin/aurora-rls-health`
directly — `404`, `text/html`, `Cannot GET`, the CLAUDE.md §15 signature
for "route does not exist on deployed code." Traced the reason before
assuming a regression: `git show origin/main:services/gateway/src/routes/
admin-health.ts` confirms the route is genuinely absent from `main`
today, and staging's own `/api/v1/admin/build-info` reports it's serving
`main`'s current tip. **This is not a lost or reverted commit** — the
commits that add it (`5cbf8178`, `4a1100b4`) are real, present on this
session's branch, and confirmed (via the GitHub API, not local git —
this checkout is shallow and its own ancestry math is unreliable) to be
part of the file set already included in the still-open PR #3087
alongside this session's other B2–B7 work. It simply hasn't merged yet.
**No action needed here beyond what's already tracked**: this resolves
itself the moment PR #3087 merges to `main`, which then auto-deploys to
staging per §16 — the same event this whole B2–B7 body of work is
already waiting on.
