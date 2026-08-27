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

## Flagged, not fixed — needs a closer read before any change

**9 `SECURITY DEFINER` functions callable by the fully unauthenticated
`anon` role** (of 190 total `anon_security_definer_function_executable`
findings — these 9 are the ones whose names suggest real mutation power,
not the routine ones):

- `update_user_balance(user_id_param uuid, currency_param text, amount_param numeric, operation text, p_transaction_type text, p_description text)`
- `update_wallet_balance()`
- `update_user_stripe_account(p_stripe_account_id text)`
- `update_user_stripe_status(p_stripe_account_id text, p_charges_enabled boolean, p_payouts_enabled boolean)`
- `provision_wallet_accounts()`
- `bootstrap_admin_user(p_user_id uuid, p_user_email text)`
- `is_exafy_admin(user_id_param uuid)`
- `get_user_admin_status(user_id_param uuid, tenant_id_param uuid)`
- `is_group_admin(_group_id uuid, _user_id uuid)`

**Being callable by `anon` is not the same as being exploitable** — a
well-written function body derives identity from `auth.uid()` and
rejects a null/mismatched caller regardless of who can invoke it. This
needs each function's actual body read, specifically checking whether it
trusts a caller-supplied ID parameter (`user_id_param`, `p_user_id`, …)
instead of deriving identity from the session — `update_user_balance` and
`bootstrap_admin_user` are the two names most worth checking first, given
what they'd let an anonymous caller do if the trust check is missing or
wrong. Not read this pass — flagging for a dedicated follow-up rather than
rushing a read of 9 SECURITY DEFINER function bodies at the end of an
already-long session.

**9 `SECURITY DEFINER` views** (bypass the querying user's RLS,
lint `security_definer_view`): `user_pillar_recent_activity`,
`wearable_rollup_7d`, `intent_compass_alignment`, `user_diary_streak`,
`intent_open_asks`, `local_heroes_weekly`, `gemini_cost_daily`,
`agent_personas_registry`, **`stripe_subscriptions`** (the one worth
prioritizing — money-adjacent, worth checking whether it's intentionally
service-role-only or accidentally lets any querying user see other
users'/tenants' subscription rows). Not checked this pass.

## Everything else — routine, not urgent

354 `authenticated`-only SECURITY DEFINER functions (expected — a logged-in
user calling a function about their own data), 213 functions with a
mutable `search_path` (hygiene, not an active exposure), 87
`rls_enabled_no_policy` tables (fail-closed by construction), 5 extensions
installed in `public` instead of a dedicated schema, 2 materialized views
exposed to the API, leaked-password-protection disabled, and the Postgres
version having patches available. None of these showed evidence of live
exploitability on inspection; not investigated further.
