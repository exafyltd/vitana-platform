# Supabase Security Advisor Audit — 2026-08-28

**Read-only.** Per the explicit standing instruction for this session and
`vitana-v1`'s absolute "never write to production Supabase" rule, this pass
is investigation and a remediation plan only — **no DDL was executed against
`inmkhvwdcuyhnxkgfvsb`.** Every fix below needs a human (or an explicitly
authorized follow-up session) to actually apply it.

Source: `mcp__Supabase__get_advisors(type=security)` against production
project `inmkhvwdcuyhnxkgfvsb`, read via a background agent that parsed the
full 828,119-char / 858-finding JSON response (not a partial sample).

## Totals

| Level | Count |
|---|---|
| ERROR | 4 |
| WARN | 764 |
| INFO | 90 (all `rls_enabled_no_policy` — RLS on, zero policies, fail-closed by default; lower urgency) |

## 1. ERROR — fix first, all four are small and unambiguous

**1a-1c. `SECURITY DEFINER` views** (run with the *creator's* privileges, not
the caller's — can leak rows past the underlying tables' RLS):
- `public.intent_open_asks`
- `public.local_heroes_weekly`
- `public.agent_personas_registry`

Before touching any of these: read each view's definition
(`pg_get_viewdef`) and confirm whether `SECURITY DEFINER` is load-bearing
(e.g. the view intentionally aggregates across tenants/users for a
public-facing rollup and relies on the definer's privilege to do so) or
accidental (Postgres's default when a `CREATE VIEW` runs as a service-role
migration). If accidental, the fix is:
```sql
ALTER VIEW public.intent_open_asks SET (security_invoker = true);
ALTER VIEW public.local_heroes_weekly SET (security_invoker = true);
ALTER VIEW public.agent_personas_registry SET (security_invoker = true);
```
then verify each view still returns the expected rows for a normal
`authenticated` caller (RLS on the underlying tables now applies) — a
regression here silently empties a page rather than erroring.

**1d. RLS Disabled in Public — `public._vtid_03506_purged_notifications`**

No RLS at all on a public-schema table. Per the platform CLAUDE.md, this
table is a VTID-03506 purge artifact (the community-notification test-actor
incident) — almost certainly not meant to be queried by any live app role.
```sql
ALTER TABLE public._vtid_03506_purged_notifications ENABLE ROW LEVEL SECURITY;
-- No policy needed if nothing legitimately reads this outside service_role —
-- RLS-enabled-with-no-policy fails closed (see the 90 INFO findings, same
-- pattern already in wide use elsewhere in this schema).
```

## 2. WARN — config-level, independent quick wins

- **`auth_leaked_password_protection`**: enable HaveIBeenPwned checking in
  Auth settings. Dashboard-only, no SQL.
- **`vulnerable_postgres_version`**: currently `supabase-postgres-17.4.1.074`
  with patches outstanding. Upgrade via project settings (causes a brief
  restart — schedule it, don't run it blind).
- **`extension_in_public`** (5): `vector`, `pg_net`, `pg_trgm`,
  `fuzzystrmatch`, `unaccent` installed in `public` instead of a dedicated
  schema. Moving an extension's schema after the fact is not a plain
  `ALTER EXTENSION ... SET SCHEMA` for all of these (some, like `vector`,
  have version-specific caveats) — treat as its own small piece of work,
  not a one-liner to batch with the rest.
- **`materialized_view_in_api`** (2): `public.ai_usage_month_by_user_provider`,
  `public.product_outcome_rollup` — selectable via the API with no RLS
  possible on a materialized view. If either carries per-user data, either
  move it out of the exposed schema or wrap it behind a `SECURITY INVOKER`
  view that joins back to a real RLS-governed table for the access check.

## 3. WARN — `function_search_path_mutable` (213 findings / 212 functions)

Every one of these is missing a pinned `search_path`, which matters most
where it overlaps with `SECURITY DEFINER` (§4 below) — an attacker able to
create an object earlier in the caller's search_path can redirect the
function's unqualified references. The fix is mechanical and — because it
only pins name resolution, not behavior, for functions that already
qualify their own object references — safe to batch for functions that
follow that convention already.

**Recommended approach: do NOT hand-transcribe 212 `ALTER FUNCTION`
statements** (two of the 212 are overloaded — `live_room_check_access` has
a 2-arg and a 3-arg form — and a hand-written signature list risks a typo
silently targeting the wrong overload or erroring). Instead, generate and
run this once `pg_proc`/`pg_namespace` are queried for exact signatures:

```sql
-- DRAFT — NOT RUN. Review the generated statement list before executing;
-- this fixes every SECURITY DEFINER function with a mutable search_path in
-- one pass, using the function's own recorded signature so overloads
-- resolve correctly.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT p.oid, n.nspname, p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'governance')
      AND (p.proconfig IS NULL
           OR NOT EXISTS (
             SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'
           ))
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %I.%I(%s) SET search_path = %L',
      r.nspname, r.proname, r.args, ''
    );
  END LOOP;
END $$;
```
Run this against a **staging/branch copy first** (Supabase branching, or a
local Postgres restore) — `search_path = ''` forces every unqualified
reference inside the function body to be schema-qualified already, and a
function that was relying on an implicit `public` search path (e.g. calling
another `public` function by its bare name) will start failing at call time,
not at `ALTER` time. That's the real risk here, not the `ALTER` itself.

## 4. WARN — `SECURITY DEFINER` functions callable by `anon`/`authenticated`

189 functions callable via `POST /rest/v1/rpc/<fn>` with **zero
authentication** (`anon`), all of which are also in the 353-function
`authenticated`-callable superset (164 more are authenticated-only). Full
lists are in the security-advisor agent's report (this session's
transcript) — not reproduced signature-by-signature here since the action
needed is triage, not a mechanical fix.

**This is judgment work, not a batch fix — do not blanket-`REVOKE`.** Many
of the 189 are legitimately meant to be anonymous-callable (e.g.
`get_public_event_details`, `resolve_event_by_slug`,
`get_public_vitana_index`, `check_phone_on_platform` for signup flows). A
smaller subset reads as higher-risk if genuinely anon-reachable and worth
a first-priority human review:

- `set_user_suspension`, `bootstrap_admin_user`, `is_exafy_admin`,
  `moderate_profile_post`, `update_user_balance`,
  `memory_delete_entity`/`memory_lock_entity`/`memory_unlock_entity`
  (anon-callable per the report)
- `allocate_global_vtid`, `create_vtid_atomic`, `write_fact`,
  `process_wallet_transfer`, `process_wallet_exchange_and_send`,
  `dev_set_request_context`, `dev_autopilot_get_table_schema`
  (authenticated-callable, i.e. any logged-in user, not just admins/service
  callers)

Before any REVOKE: confirm via `query_logs`/PostgREST access logs whether
each is actually invoked via `/rpc/` in practice, vs. flagged defensively
by the linter for a grant nobody uses (many of the 189 are clearly trigger
functions — `notify_on_*`, `sync_*_count` — that would only appear here if
they were also granted a stray direct-call EXECUTE). A trigger function
does not need EXECUTE granted to `anon`/`authenticated` at all; if it has
it and nothing calls it directly, revoking is a pure safety improvement
with no behavior risk. Functions doing real mutation
(`set_user_suspension`, `update_user_balance`, wallet transfers) need the
opposite check — confirm the function's OWN internal auth check (most
likely reads `auth.uid()`/`current_user_id()` and validates ownership) is
actually sufficient before assuming the PostgREST grant is the only gate.

## 5. INFO — `rls_enabled_no_policy` (90 tables)

Fail-closed by construction (RLS on + no policy = default deny for
non-owner roles), so these are not a live exposure — but each is worth a
pass to confirm it's deliberately locked down (e.g. `service_role`-only by
design) rather than a table someone forgot to finish policy-ing while it
sits unreachable. Full 90-table list available in the advisor response;
first two observed were `public."OasisEvent"` and `public.admin_settings`.

## What this session did NOT do, and why

- **No `ALTER`/`REVOKE`/`CREATE OR REPLACE` was run against production.**
  Every SQL block above is a draft for a human (or an explicitly authorized
  write-capable session) to review and run — consistent with the standing
  instruction for this pass ("do not write to production Supabase... flag
  any fix that would need a write for the user instead").
- **The 189+164 function-executable lists were not individually triaged
  against real call logs** — that needs `query_logs` access to
  PostgREST/edge access logs at a volume this pass didn't have budget for
  alongside the rest of the Aurora migration work; flagging as the next
  step for whoever picks up §4.
