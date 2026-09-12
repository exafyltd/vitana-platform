# Supabase Security Advisor — critical findings and fixes, 2026-08-27

**VTID-03777.** Ran Supabase's own security advisor against the live
`VITANA` project (`inmkhvwdcuyhnxkgfvsb`) — 866 findings total (13 ERROR,
766 WARN, 87 INFO). Most of the volume is routine hygiene debt (213
functions with a mutable `search_path`, 87 tables with RLS enabled but no
policy — fail-closed, not an exposure). This doc covers only the findings
that needed a live-data check to size correctly, and the three that got
fixed immediately.

## Fixed immediately: three tables, full anonymous read+write, zero RLS

Checked actual grants (`information_schema.role_table_grants`, not just
the advisor's own severity label) for every ERROR-level
`rls_disabled_in_public` finding. Three had **RLS completely off AND
`anon`/`authenticated` both holding full `SELECT`/`INSERT`/`UPDATE`/
`DELETE`** — meaning any unauthenticated internet request to
`/rest/v1/<table>` could read, write, or delete these tables' contents,
live, at the time this was found:

| Table | Live row count | What it holds | Real exposure |
|---|---:|---|---|
| `public.partner_oauth_credential` | 0 | `access_token`, `token_type`, `scope`, `endpoint_domain`, `provider` — plaintext OAuth credentials for outbound partner integrations | 0 rows today, but any future write would be publicly readable, and anyone could insert an attacker-controlled token/endpoint a downstream integration might trust |
| `public.admin_settings` | 1 | `key`/`value`/`updated_by` — admin/feature-flag config | The one live row was publicly writable **right now** — an anonymous request could have altered a real admin setting |
| `public.subid_map` | 0 | Stripe-subscription-ID mapping (money-adjacent, by name and shape) | Same as `partner_oauth_credential` — empty today, exposed the moment it's used |

**Verified no legitimate code path needs this before fixing:** grepped
both `exafyltd/vitana-platform` and `exafyltd/vitana-v1` for every call
site touching these three table names — all of them are in
`services/gateway/src/**`, which authenticates to Supabase via the
service-role key (bypasses RLS entirely, unaffected by this change). Zero
call sites in the frontend (`vitana-v1/src`) or anywhere using the
`anon`/`authenticated` role. There is no reason `anon`/`authenticated`
should ever have been able to reach these tables directly.

**Fix applied:** `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on all three,
with no policy added — the exact same safe-default posture already in use
on 87 other tables in this schema (the advisor's own `rls_enabled_no_policy`
INFO-level findings). `service_role` bypasses RLS by design, so the
gateway's existing access is completely unaffected; `anon`/`authenticated`
now get zero rows back instead of the underlying grants applying directly.
Verified live immediately after: `pg_class.relrowsecurity = true` on all
three.

**Deliberately not also revoked:** the underlying `GRANT`s to
`anon`/`authenticated` are still there, just inert behind RLS now —
matching the 87-table precedent exactly rather than introducing a second,
less-precedented lockdown pattern (an explicit `REVOKE`) for a
one-off inconsistency with the rest of the schema.

## Also fixed: two more live, exploitable bugs found by reading all 9 function bodies

Read every one of the 9 `SECURITY DEFINER` functions named above (of 190
total `anon_security_definer_function_executable` findings — these 9 were
the ones whose names suggested real mutation power). Two were genuinely
exploitable; both fixed immediately for the same reason as the RLS fixes
above — narrow, unambiguous, verified-safe for the legitimate caller.

### `update_user_balance` — anonymous wallet manipulation, fixed

```sql
IF auth.uid() IS NOT NULL AND auth.uid() <> user_id_param THEN
  RAISE EXCEPTION 'Not authorized to modify another user''s wallet';
END IF;
```

For an unauthenticated caller, `auth.uid()` is `NULL`, so
`auth.uid() IS NOT NULL` is false and the whole guard never fires — the
function's own stated intent ("not authorized to modify another user's
wallet") only applied to a *different authenticated* user, never to *no*
authentication at all. Confirmed live and exploitable, not theoretical:
`anon` has `EXECUTE` on this function, and `public.user_wallets` holds
**693 real rows**. Any unauthenticated caller could call
`update_user_balance(<any real user_id>, 'EUR', 1000000, 'add')` to
credit an arbitrary amount to any user's wallet, or `'subtract'` to debit
one (bounded only by that user's current balance, not by caller
identity).

**Fix:** `auth.uid() IS NULL OR auth.uid() <> user_id_param` — now
correctly rejects both "no session" and "wrong user," matching the
function's own error message. `CREATE OR REPLACE`, changed nothing else.
Verified live: `prosrc` now contains the corrected condition.

### `update_user_stripe_status` — no identity check at all, fixed by removing public reachability

```sql
UPDATE app_users
SET stripe_charges_enabled = p_charges_enabled, stripe_payouts_enabled = p_payouts_enabled
WHERE stripe_account_id = p_stripe_account_id;
```

No `auth.uid()` check whatsoever — trusts the caller-supplied
`p_stripe_account_id` alone. Its sibling, `update_user_stripe_account`,
correctly scopes by `WHERE user_id = auth.uid()` (safe for an anonymous
caller — `auth.uid()` is `NULL`, so the `WHERE` matches nothing), but
this one has no equivalent scoping to add, because **it isn't supposed to
be called by an end user at all**: its only real caller,
`services/gateway/src/routes/stripe-connect-webhook.ts:137`, invokes it
with a service-role token as part of processing a real Stripe Connect
webhook. It only reached `anon`/`authenticated` because Postgres grants
`EXECUTE` to the implicit `PUBLIC` role by default on function creation,
and this one was never explicitly restricted — confirmed live:
`has_function_privilege('public', ...)` was `true` before the fix.

**Fix:** `REVOKE EXECUTE ... FROM PUBLIC` (an explicit per-role `REVOKE`
alone does nothing while `PUBLIC` still grants it — confirmed by testing:
revoking from `anon`/`authenticated` directly left `has_function_privilege`
still `true` for both until `PUBLIC` itself was revoked), then
`GRANT EXECUTE ... TO service_role` explicitly so the legitimate webhook
path is unambiguous rather than relying on `service_role`'s own implicit
privileges. Verified live: `anon`/`authenticated`/`public` all `false`,
`service_role` still `true` — the real caller is unaffected.

### The other 7 — checked, not exploitable or not real RPC surface

- **`bootstrap_admin_user`** — correctly checks
  `auth.jwt() -> 'app_metadata' ->> 'exafy_admin'`, which is `NULL` (→
  `false`) for an anonymous caller. Safe as written.
- **`update_user_stripe_account`** — safe by construction, see above.
- **`is_exafy_admin`, `get_user_admin_status`, `is_group_admin`** — all
  three are read-only boolean status checks (`SELECT EXISTS(...)`) with
  no `auth.uid()` guard, so an anonymous caller can probe "is user X an
  admin of tenant/group Y" for any ID they supply. Real, but a narrow
  information-disclosure ceiling (a boolean, not a data leak or a
  mutation) — left as-is rather than risking a behavior change to
  functions three other code paths likely depend on being callable this
  way, without checking every caller in a session already this long.
- **`provision_wallet_accounts`, `update_wallet_balance`** — both
  `RETURNS trigger`; Postgres only binds `NEW`/`OLD` inside real trigger
  context, so calling either directly via `/rest/v1/rpc/...` errors out
  rather than executing — the advisor's `anon_security_definer_function_executable`
  lint doesn't distinguish trigger functions from directly-callable ones,
  a false-positive-shaped entry for this specific lint, not a live gap.

## Also fixed: 6 of the 9 SECURITY DEFINER views were real cross-user data leaks

Read all 9 (lint `security_definer_view` — a `SECURITY DEFINER` view runs as
its owner, `postgres`, and silently bypasses the querying user's RLS unless
`security_invoker = on` is set on the view itself). For each, checked
whether the underlying table(s) actually carry restrictive RLS that the view
was bypassing, and whether any live code depends on that bypass.

**Confirmed real, exploitable cross-user leaks — fixed via
`ALTER VIEW ... SET (security_invoker = on)`,** which makes each view
enforce the *querying role's* RLS instead of running as `postgres`. This is
the standard Postgres 15+ fix for this exact lint, and is zero-risk for the
one real caller class found for each (gateway backend code, which — per
this codebase's own established `getSupabase()` pattern, confirmed earlier
in this doc for the two function fixes — authenticates with `service_role`,
and `service_role` bypasses RLS unconditionally regardless of
`security_invoker`. No frontend/`vitana-v1` call site exists for any of
these six):

| View | Base table(s) | Base table RLS | What was exposed to any anon/authenticated caller |
|---|---|---|---|
| `stripe_subscriptions` | `user_subscriptions` | `auth.uid() = user_id` (own row only) | Every user's subscription status, plan, `last_payment_error`, `stripe_customer_id`, tenant. **0 live rows today** (no row yet has `stripe_subscription_id` set) — dormant until the first real Stripe subscription writes one. |
| `user_pillar_recent_activity` | `calendar_events` | `auth.uid() = user_id` (own row only) | Every user's per-pillar wellness completion counts (nutrition/sleep/exercise/mental) for the last 24h/7d — health-adjacent behavioral data, live today. |
| `wearable_rollup_7d` | `wearable_daily_metrics` | `user_id = auth.uid()` (own row only; service_role separately allowed) | Every user's 7-day sleep minutes, HRV, resting heart rate, activity minutes — real biometric health data, live today. |
| `intent_compass_alignment` | `user_intents`, `life_compass` | Owner-only (`auth.uid() = requester_user_id` / `= user_id`) plus narrow tenant/public-visibility carve-outs | Every user's personal life-goal category (`life_compass.primary_goal`) joined to their intents, regardless of the intent's own visibility — bypassed `user_intents`' own public/tenant visibility policy, not just ownership. |
| `user_diary_streak` | `diary_entries` | `auth.uid() = user_id` (own row only, per-command policies) | Every user's current diary-journaling streak length and last-entry date — reveals journaling behavior/consistency for every user, not content, but still a real per-user behavioral leak. |
| `gemini_cost_daily` | `gemini_call_log` | RLS **enabled with zero policies** (fail-closed for every non-owner role — same 87-table precedent as the RLS section above) | Internal AI-cost/ops telemetry: daily calls/tokens/latency/error+fallback counts per feature and model. **49 real rows, live today** (Apr–Jul 2026) — business-sensitive operational data (what models cost, how often they fail/fall back), not user data, but still a real live exposure to anyone unauthenticated. |

Verified live after each fix: `security_invoker` reads `'on'` in
`pg_class.reloptions` for all six.

## Reviewed, left as-is — intentional by an existing policy or a genuine product-design call

- **`agent_personas_registry`** (→ `agent_personas`) — the base table
  already carries an explicit, permissive policy,
  `agent_personas_select: (status <> 'disabled')`, with **no `auth.uid()`
  scoping at all** — any caller, including anonymous, can already read
  non-disabled personas directly off the table. The view (filtered to
  `status='active'`, a subset of "not disabled") isn't bypassing a
  restriction; it's redundant with one the schema already made
  deliberately public. That policy does mean `system_prompt` is
  intentionally exposed to anonymous callers today — a real product/security
  posture, but one already baked into the table's own RLS, not something
  this view introduced or that a `security_invoker` flip would change.
  Flagging for awareness, not fixing unilaterally.
- **`local_heroes_weekly`** (→ `user_reputation` + `profiles`) —
  `user_reputation` itself is RLS-enabled with **zero policies**
  (fail-closed, same shape as `gemini_call_log` above), so the view is a
  real bypass in the same technical sense. But unlike `gemini_cost_daily`,
  this reads as a plausible intentional design: a curated, rate-limited
  "public leaderboard" view (ranked, filtered to recently-active users only,
  exposing only `display_name`/`avatar_url`/rank/counts — no raw
  `user_reputation` rows) sitting in front of an otherwise-locked-down base
  table is a common and legitimate gamification pattern. Also,
  `profiles` itself already has an `Authenticated users can view profiles:
  true` policy with no `auth.uid()` scoping, so the identity half
  (display_name/avatar/city) is not actually private for authenticated
  callers regardless of this view. Left as-is rather than guessing at
  product intent; worth a human call on whether `anon` (not just
  `authenticated`) should see it.
- **`intent_open_asks`** — the view's own `WHERE status='open' AND
  visibility='public'` mirrors `user_intents`' own
  `user_intents_public_read` RLS policy almost exactly (open/matched/engaged
  + `visibility='public'` + active tenant membership). This is a curated
  public-marketplace view by design, not a bypass — the one gap is it drops
  `user_intents_public_read`'s tenant-membership check, so a caller need not
  share a tenant with the intent's author, unlike the base policy. Given the
  visibility is explicitly `'public'` already (the author opted into
  public-not-tenant-scoped visibility), this reads as a narrower, not wider,
  exposure than the base policy allows for `visibility='tenant'` rows, and
  is very likely intentional. Left as-is.

## Everything else — routine, not urgent

354 `authenticated`-only SECURITY DEFINER functions (expected — a logged-in
user calling a function about their own data), 213 functions with a
mutable `search_path` (hygiene, not an active exposure), 87
`rls_enabled_no_policy` tables (fail-closed by construction), 5 extensions
installed in `public` instead of a dedicated schema, 2 materialized views
exposed to the API, leaked-password-protection disabled, and the Postgres
version having patches available. None of these showed evidence of live
exploitability on inspection; not investigated further.
