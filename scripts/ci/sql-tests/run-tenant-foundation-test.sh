#!/usr/bin/env bash
# VTID-05149: tenant foundation (M1 default/platform flags, M2 signup default
# tenant, M3 ci_tenant_isolation_health) against a throwaway Postgres. Needs PG*
# env vars (or a local socket) pointing at a disposable server whose roles this
# script may create (anon, authenticated, service_role). Refuses to run against
# anything that looks like Supabase or Aurora. Each case gets its own database
# with the fixture from vtid-05149-tenant-foundation.test.sql.
#
# Cases: golden (the live bodies and M1+M2 write identical rows and fire the same
# side effects in the same order for the same signups), determinism (the tied
# created_at no longer decides), hardening (closed / platform / inactive slug →
# default), invariants (exactly one default, swap in one transaction, CHECK,
# the deferred trigger fires for `authenticated` with EXECUTE revoked), no
# default (WARNING, the signup still succeeds), the RPC (exact counts, a failing
# table in scan_errors, members denied), guards (drift, order, re-apply) and the
# rollback R3 → R2 → R1 restoring the before-state.
set -euo pipefail
case "${PGHOST:-local}" in
  *supabase*|*amazonaws*|*rds*) echo "refusing: PGHOST=${PGHOST} is not a throwaway database" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
FIXTURE="$ROOT/scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql"
M1="$ROOT/supabase/migrations/20261014000100_vtid_05149_tenants_default_platform_flags.sql"
M2="$ROOT/supabase/migrations/20261014000200_vtid_05149_signup_default_tenant.sql"
M3="$ROOT/supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql"
EV="$ROOT/docs/validation/VTID-05149"
BEFORE="$EV/functions-before.sql"
R1="$EV/rollback-m1.sql"; R2="$EV/rollback-m2.sql"; R3="$EV/rollback-m3.sql"
for f in "$FIXTURE" "$M1" "$M2" "$M3" "$BEFORE" "$R1" "$R2" "$R3"; do
  [ -f "$f" ] || { echo "missing: $f" >&2; exit 2; }
done

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
WORK="$(mktemp -d)"
DBS=()
BG=""
cleanup() {
  [ -n "$BG" ] && kill "$BG" >/dev/null 2>&1 || true
  for d in "${DBS[@]}"; do dropdb --if-exists "$d" >/dev/null 2>&1 || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() { echo "FAIL $*" >&2; exit 1; }

"${PSQL[@]}" -d postgres <<'SQL'
DO $$
BEGIN
  IF to_regrole('anon') IS NULL THEN CREATE ROLE anon NOLOGIN; END IF;
  IF to_regrole('authenticated') IS NULL THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF to_regrole('service_role') IS NULL THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
SQL

MAXINA=2e7528b8-472a-4356-88da-0280d4639cce
ALKALMA=73cc592f-84ec-457a-b0f7-25a082d7e011
TIE="2025-08-30 16:27:07.760873+00"

# Sets $db (not echoed: a command substitution would lose the DBS entry).
newdb() {
  db="tenant_foundation_${1}_$$"
  createdb "$db"
  DBS+=("$db")
  "${PSQL[@]}" -d "$db" -f "$FIXTURE" >/dev/null
}
q() { "${PSQL[@]}" -d "$1" -tA -c "$2"; }
run() { "${PSQL[@]}" -d "$1" -f "$2" >"$WORK/$1.$(basename "$2").log" 2>&1 || { cat "$WORK/$1.$(basename "$2").log" >&2; fail "[$1] $(basename "$2") should have applied"; }; }
refused() {
  if "${PSQL[@]}" -d "$1" -f "$2" >"$WORK/$1.refused.log" 2>&1; then fail "[$1] $(basename "$2") applied but should have been refused"; fi
  grep -q "$3" "$WORK/$1.refused.log" || { cat "$WORK/$1.refused.log" >&2; fail "[$1] expected error: $3"; }
}
# SQL that must fail with $3 in its error.
sql_fails() {
  if "${PSQL[@]}" -d "$1" -c "$2" >"$WORK/$1.sqlfail.log" 2>&1; then fail "[$1] should have failed: $2"; fi
  grep -q "$3" "$WORK/$1.sqlfail.log" || { cat "$WORK/$1.sqlfail.log" >&2; fail "[$1] expected error '$3' from: $2"; }
}
eq() { [ "$2" = "$3" ] || fail "$1: got '$2', want '$3'"; }

# Live order: maxina is physically first (that is why the oldest-tenant tie
# resolves to maxina today). $2=alkalma_first flips it.
tenants() {
  if [ "${2:-}" = alkalma_first ]; then
    q "$1" "INSERT INTO public.tenants (tenant_id, name, slug, created_at, open_signup) VALUES ('$ALKALMA', 'Alkalma', 'alkalma', '$TIE', true)"
    q "$1" "INSERT INTO public.tenants (tenant_id, name, slug, created_at, open_signup) VALUES ('$MAXINA', 'Maxina', 'maxina', '$TIE', true)"
  else
    q "$1" "INSERT INTO public.tenants (tenant_id, name, slug, created_at, open_signup) VALUES ('$MAXINA', 'Maxina', 'maxina', '$TIE', true)"
    q "$1" "INSERT INTO public.tenants (tenant_id, name, slug, created_at, open_signup) VALUES ('$ALKALMA', 'Alkalma', 'alkalma', '$TIE', true)"
  fi
}
closedco() {
  q "$1" "INSERT INTO public.tenants (tenant_id, name, slug, created_at, open_signup) VALUES ('00000000-0000-0000-0000-0000000000c1', 'Closed Co', 'closedco', '2026-01-01', false)"
}
# signup <db> <n> [slug] — inserts auth.users like Supabase Auth does.
signup() {
  local meta='{"full_name": "User '"$2"'"}'
  [ -n "${3:-}" ] && meta='{"full_name": "User '"$2"'", "tenant_slug": "'"$3"'"}'
  "${PSQL[@]}" -d "$1" -c "INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('00000000-0000-0000-0000-0000000000$(printf %02d "$2")', 'u$2@example.test', '$meta'::jsonb)" \
    >"$WORK/$1.signup$2.log" 2>&1 || { cat "$WORK/$1.signup$2.log" >&2; fail "[$1] signup $2 failed"; }
}
uid() { echo "00000000-0000-0000-0000-0000000000$(printf %02d "$1")"; }
primary_slug() { q "$1" "SELECT t.slug FROM public.user_tenants ut JOIN public.tenants t USING (tenant_id) WHERE ut.user_id = '$(uid "$2")' AND ut.is_primary"; }

# Every row the two triggers write (generated ids and timestamps excluded) + the
# side-effect log in firing order.
snapshot() {
  "${PSQL[@]}" -d "$1" -tA >"$2" <<'SQL'
SELECT 'auth.users', id, raw_app_meta_data FROM auth.users ORDER BY id;
SELECT 'profiles', user_id, full_name, display_name, handle, email, vitana_id, vitana_id_locked, registration_seq, tenant_id FROM public.profiles ORDER BY user_id;
SELECT 'global_community_profiles', user_id, display_name, is_visible FROM public.global_community_profiles ORDER BY user_id;
SELECT 'memberships', user_id, tenant_id, role, status FROM public.memberships ORDER BY user_id, tenant_id;
SELECT 'role_preferences', user_id, tenant_id, role FROM public.role_preferences ORDER BY user_id, tenant_id;
SELECT 'app_users', user_id, tenant_id, status, email, display_name FROM public.app_users ORDER BY user_id;
SELECT 'user_tenants', user_id, tenant_id, active_role, is_primary FROM public.user_tenants ORDER BY user_id, tenant_id;
SELECT 'user_permitted_roles', user_id, tenant_id, role, granted_by FROM public.user_permitted_roles ORDER BY user_id, tenant_id, role;
SELECT 'side_effect_log', seq, trigger_name, user_id, tenant_id FROM public.side_effect_log ORDER BY seq;
SQL
}

# Catalog state M1-M3 touch (rollback target).
catalog() {
  "${PSQL[@]}" -d "$1" -tA >"$2" <<'SQL'
SELECT 'col', column_name, data_type, is_nullable, coalesce(column_default, '') FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tenants' ORDER BY ordinal_position;
SELECT 'con', conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.tenants'::regclass ORDER BY conname;
SELECT 'idx', indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'tenants' ORDER BY indexname;
SELECT 'trg', tgname FROM pg_trigger WHERE tgrelid = 'public.tenants'::regclass AND NOT tgisinternal ORDER BY tgname;
SELECT 'fn', p.oid::regprocedure::text, md5(pg_get_functiondef(p.oid)), coalesce(p.proacl::text, '') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 2;
SQL
}

# ---------------------------------------------------------------------------
# 1) Golden: the live bodies vs M1+M2, same 4 signups → identical rows.
# ---------------------------------------------------------------------------
newdb before; DB_BEFORE="$db"
tenants "$DB_BEFORE"
run "$DB_BEFORE" "$BEFORE"
eq 'live md5 handle_new_user reproduced' "$(q "$DB_BEFORE" "SELECT md5(pg_get_functiondef('public.handle_new_user()'::regprocedure))")" 9599cfbfa7d9f8532ea1564df99e430f
eq 'live md5 provision_platform_user reproduced' "$(q "$DB_BEFORE" "SELECT md5(pg_get_functiondef('public.provision_platform_user()'::regprocedure))")" 6254e35b2765d8edd5976ec5b9eec4f3
closedco "$DB_BEFORE"
signup "$DB_BEFORE" 1; signup "$DB_BEFORE" 2 maxina; signup "$DB_BEFORE" 3 alkalma; signup "$DB_BEFORE" 4 nosuchtenant
snapshot "$DB_BEFORE" "$WORK/golden-before.txt"

newdb after; DB_AFTER="$db"
tenants "$DB_AFTER"
run "$DB_AFTER" "$BEFORE"
run "$DB_AFTER" "$M1"
eq 'M1 committed on the 2-row table; default' "$(q "$DB_AFTER" "SELECT string_agg(slug, ',') FROM public.tenants WHERE is_default")" maxina
run "$DB_AFTER" "$M2"
closedco "$DB_AFTER"
signup "$DB_AFTER" 1; signup "$DB_AFTER" 2 maxina; signup "$DB_AFTER" 3 alkalma; signup "$DB_AFTER" 4 nosuchtenant
snapshot "$DB_AFTER" "$WORK/golden-after.txt"

diff -u "$WORK/golden-before.txt" "$WORK/golden-after.txt" || fail 'golden: M1+M2 changed what a signup writes'
eq 'golden: 4 user_tenants primaries' "$(grep -c '^user_tenants|.*|community|t$' "$WORK/golden-after.txt")" 4
for n in 1 2 4; do eq "golden: user $n tenant" "$(primary_slug "$DB_AFTER" "$n")" maxina; done
eq 'golden: user 3 tenant' "$(primary_slug "$DB_AFTER" 3)" alkalma
eq 'golden: side effects per signup, in order' \
  "$(q "$DB_AFTER" "SELECT string_agg(trigger_name, ',' ORDER BY seq) FROM public.side_effect_log WHERE user_id = '$(uid 1)'")" \
  'founding_seat_on_primary_membership,seed_onboarding_autopilot_on_primary_membership,trg_create_user_live_room,welcome_chat_on_primary_membership'
eq 'golden: side-effect rows' "$(q "$DB_AFTER" "SELECT count(*) FROM public.side_effect_log")" 16
eq 'golden: app_metadata active tenant = memberships tenant' \
  "$(q "$DB_AFTER" "SELECT count(*) FROM auth.users u JOIN public.memberships m ON m.user_id = u.id AND m.tenant_id::text = u.raw_app_meta_data ->> 'active_tenant_id' JOIN public.user_tenants ut ON ut.user_id = u.id AND ut.tenant_id = m.tenant_id AND ut.is_primary")" 4
echo "     M2 md5 handle_new_user:         $(q "$DB_AFTER" "SELECT md5(pg_get_functiondef('public.handle_new_user()'::regprocedure))")"
echo "     M2 md5 provision_platform_user: $(q "$DB_AFTER" "SELECT md5(pg_get_functiondef('public.provision_platform_user()'::regprocedure))")"
echo 'ok 1 golden: live bodies and M1+M2 write identical rows in all 7 tables + app_metadata, 4 side effects per signup in the same order'

# ---------------------------------------------------------------------------
# 2) Determinism: alkalma physically first.
# ---------------------------------------------------------------------------
newdb determinism
tenants "$db" alkalma_first
run "$db" "$BEFORE"
signup "$db" 1
echo "     old bodies, alkalma physically first: a no-slug signup landed in '$(primary_slug "$db" 1)' (the created_at tie decides)"
run "$db" "$M1"; run "$db" "$M2"
signup "$db" 2
eq 'determinism: no-slug signup under M2' "$(primary_slug "$db" 2)" maxina
eq 'determinism: memberships tenant under M2' "$(q "$db" "SELECT t.slug FROM public.memberships m JOIN public.tenants t USING (tenant_id) WHERE m.user_id = '$(uid 2)'")" maxina
echo 'ok 2 determinism: with alkalma physically first a no-slug signup lands in maxina (is_default)'

# ---------------------------------------------------------------------------
# 3) Hardening: closed / platform / inactive slugs fall back to the default.
# ---------------------------------------------------------------------------
db="$DB_AFTER"
q "$db" "INSERT INTO public.tenants (name, slug, open_signup, is_platform) VALUES ('Platform', 'platco', true, true)"
q "$db" "INSERT INTO public.tenants (name, slug, open_signup, is_active) VALUES ('Sleeping', 'sleepco', true, false)"
signup "$db" 11 closedco; signup "$db" 12 platco; signup "$db" 13 sleepco
for n in 11 12 13; do
  eq "hardening: user $n user_tenants" "$(primary_slug "$db" "$n")" maxina
  eq "hardening: user $n memberships" "$(q "$db" "SELECT t.slug FROM public.memberships m JOIN public.tenants t USING (tenant_id) WHERE m.user_id = '$(uid "$n")'")" maxina
done
echo 'ok 3 hardening: slugs of a closed, a platform and an inactive tenant land in the default tenant'

# ---------------------------------------------------------------------------
# 4) Invariants.
# ---------------------------------------------------------------------------
sql_fails "$db" "UPDATE public.tenants SET is_default = true WHERE slug = 'alkalma'" 'tenants_one_default'
sql_fails "$db" "UPDATE public.tenants SET is_default = false WHERE slug = 'maxina'" 'exactly one tenant must have is_default = true, found 0'
q "$db" "BEGIN; UPDATE public.tenants SET is_default = false WHERE slug = 'maxina'; UPDATE public.tenants SET is_default = true WHERE slug = 'alkalma'; COMMIT;" >/dev/null
eq 'invariants: swapped default' "$(q "$db" "SELECT string_agg(slug, ',') FROM public.tenants WHERE is_default")" alkalma
q "$db" "BEGIN; UPDATE public.tenants SET is_default = false WHERE slug = 'alkalma'; UPDATE public.tenants SET is_default = true WHERE slug = 'maxina'; COMMIT;" >/dev/null
sql_fails "$db" "UPDATE public.tenants SET is_platform = true WHERE slug = 'maxina'" 'tenants_default_not_platform'
sql_fails "$db" "DELETE FROM public.tenants WHERE slug = 'maxina'" 'violates\|exactly one tenant'
eq 'invariants: authenticated has no EXECUTE on the trigger function' \
  "$(q "$db" "SELECT has_function_privilege('authenticated', 'public.tenants_assert_one_default()', 'EXECUTE')")" f
q "$db" "ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY; CREATE POLICY harness_open ON public.tenants TO authenticated USING (true) WITH CHECK (true); GRANT UPDATE ON public.tenants TO authenticated;" >/dev/null
sql_fails "$db" "SET ROLE authenticated; UPDATE public.tenants SET is_default = false WHERE slug = 'maxina'" 'exactly one tenant must have is_default = true, found 0'
q "$db" "DROP POLICY harness_open ON public.tenants; ALTER TABLE public.tenants DISABLE ROW LEVEL SECURITY; REVOKE UPDATE ON public.tenants FROM authenticated;" >/dev/null
eq 'invariants: default unchanged' "$(q "$db" "SELECT string_agg(slug, ',') FROM public.tenants WHERE is_default")" maxina
echo 'ok 4 invariants: second default refused, zero defaults refused at COMMIT, swap in one transaction, CHECK, delete of the default refused, fires for authenticated with EXECUTE revoked'

# ---------------------------------------------------------------------------
# 5) No default (constraint trigger disabled in this test only): the signup
#    still succeeds, a WARNING is raised, no membership is created.
# ---------------------------------------------------------------------------
q "$db" "ALTER TABLE public.tenants DISABLE TRIGGER tenants_exactly_one_default; UPDATE public.tenants SET is_default = false;" >/dev/null
signup "$db" 21
grep -q "WARNING:  VTID-05149: no default tenant for $(uid 21)" "$WORK/$db.signup21.log" || { cat "$WORK/$db.signup21.log" >&2; fail 'no default: WARNING missing'; }
eq 'no default: profile written' "$(q "$db" "SELECT count(*) FROM public.profiles WHERE user_id = '$(uid 21)'")" 1
eq 'no default: no membership rows' "$(q "$db" "SELECT (SELECT count(*) FROM public.memberships WHERE user_id = '$(uid 21)') + (SELECT count(*) FROM public.role_preferences WHERE user_id = '$(uid 21)') + (SELECT count(*) FROM public.app_users WHERE user_id = '$(uid 21)') + (SELECT count(*) FROM public.user_tenants WHERE user_id = '$(uid 21)') + (SELECT count(*) FROM public.user_permitted_roles WHERE user_id = '$(uid 21)')")" 0
eq 'no default: no active tenant in app_metadata' "$(q "$db" "SELECT coalesce(raw_app_meta_data ->> 'active_tenant_id', 'none') FROM auth.users WHERE id = '$(uid 21)'")" none
q "$db" "UPDATE public.tenants SET is_default = true WHERE slug = 'maxina'; ALTER TABLE public.tenants ENABLE TRIGGER tenants_exactly_one_default;" >/dev/null
echo 'ok 5 no default: signup succeeds with a WARNING and creates no membership'

# ---------------------------------------------------------------------------
# 6) ci_tenant_isolation_health(): exact counts, scan_errors, grants.
# ---------------------------------------------------------------------------
newdb rpc; DB_RPC="$db"
tenants "$db"
run "$db" "$M1"
run "$db" "$M3"
"${PSQL[@]}" -d "$db" >/dev/null <<SQL
ALTER TABLE auth.users DISABLE TRIGGER USER;
INSERT INTO auth.users (id, email) SELECT ('00000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'r' || n || '@example.test' FROM generate_series(1, 4) n;
INSERT INTO public.app_users (user_id, tenant_id, email) SELECT ('00000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid, '$MAXINA', 'r' || n || '@example.test' FROM generate_series(1, 3) n;
-- user 1: zero primaries; user 2: two primaries; user 3: normal; user 4: memberships only.
INSERT INTO public.user_tenants (tenant_id, user_id, is_primary) VALUES
  ('$MAXINA', '$(uid 1)', false), ('$MAXINA', '$(uid 2)', true), ('$ALKALMA', '$(uid 2)', true), ('$MAXINA', '$(uid 3)', true);
INSERT INTO public.memberships (user_id, tenant_id) VALUES ('$(uid 3)', '$MAXINA'), ('$(uid 4)', '$ALKALMA');
CREATE TABLE public.t_iso (id serial PRIMARY KEY, tenant_id uuid, secret text);
INSERT INTO public.t_iso (tenant_id, secret) VALUES (gen_random_uuid(), 'a'), (gen_random_uuid(), 'b'), (NULL, 'c'), ('$MAXINA', 'd');
CREATE TABLE public.t_locked (tenant_id uuid);
INSERT INTO public.t_locked VALUES (gen_random_uuid());
CREATE TABLE public.t_text (tenant_id text);
SQL
J="$(q "$db" "SELECT public.ci_tenant_isolation_health()::text")"
jv() { printf '%s' "$J" | jq -c "$1"; }
eq 'rpc: keys' "$(jv 'keys')" '["auth_users_without_membership","default_tenant_count","foreign_tenant_rows","foreign_tenant_tables","generated_at","memberships_not_in_user_tenants","null_tenant_rows","null_tenant_tables","platform_tenant_count","scan_errors","tables_scanned","text_tenant_id_tables","user_tenants_not_in_memberships","users_multi_primary","users_zero_primary"]'
eq 'rpc: tables_scanned' "$(jv .tables_scanned)" 9
eq 'rpc: text_tenant_id_tables' "$(jv .text_tenant_id_tables)" 1
eq 'rpc: foreign_tenant_rows' "$(jv .foreign_tenant_rows)" 3
eq 'rpc: foreign_tenant_tables' "$(jv .foreign_tenant_tables)" '[{"rows":2,"table":"t_iso"},{"rows":1,"table":"t_locked"}]'
eq 'rpc: null_tenant_rows' "$(jv .null_tenant_rows)" 1
eq 'rpc: null_tenant_tables' "$(jv .null_tenant_tables)" '[{"rows":1,"table":"t_iso"}]'
eq 'rpc: users_zero_primary' "$(jv .users_zero_primary)" 1
eq 'rpc: users_multi_primary' "$(jv .users_multi_primary)" 1
eq 'rpc: auth_users_without_membership' "$(jv .auth_users_without_membership)" 1
eq 'rpc: memberships_not_in_user_tenants' "$(jv .memberships_not_in_user_tenants)" 1
eq 'rpc: user_tenants_not_in_memberships' "$(jv .user_tenants_not_in_memberships)" 3
eq 'rpc: default_tenant_count' "$(jv .default_tenant_count)" 1
eq 'rpc: platform_tenant_count' "$(jv .platform_tenant_count)" 0
eq 'rpc: scan_errors' "$(jv .scan_errors)" '[]'
printf '%s' "$J" | grep -q '"secret"\|"a"\|"b"' && fail 'rpc: returned row content'
# A table that cannot be scanned (lock held by another session) → scan_errors, the rest still counted.
"${PSQL[@]}" -d "$db" -c "BEGIN; LOCK TABLE public.t_locked IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(20); COMMIT;" >/dev/null 2>&1 &
BG=$!
for _ in $(seq 1 50); do
  [ "$(q "$db" "SELECT count(*) FROM pg_locks WHERE relation = 'public.t_locked'::regclass AND mode = 'AccessExclusiveLock' AND granted")" = 1 ] && break
  sleep 0.1
done
J="$("${PSQL[@]}" -d "$db" -tA -c "SET lock_timeout = '300ms'; SELECT public.ci_tenant_isolation_health()::text")"
kill "$BG" >/dev/null 2>&1 || true; wait "$BG" 2>/dev/null || true; BG=""
eq 'rpc lock: scan_errors' "$(jv .scan_errors)" '[{"table":"t_locked","sqlstate":"55P03"}]'
eq 'rpc lock: tables_scanned' "$(jv .tables_scanned)" 8
eq 'rpc lock: foreign rows of the scanned tables' "$(jv .foreign_tenant_rows)" 2
sql_fails "$db" "SET ROLE anon; SELECT public.ci_tenant_isolation_health()" 'permission denied for function ci_tenant_isolation_health'
sql_fails "$db" "SET ROLE authenticated; SELECT public.ci_tenant_isolation_health()" 'permission denied for function ci_tenant_isolation_health'
eq 'rpc: service_role call' "$(q "$db" "SET ROLE service_role; SELECT (public.ci_tenant_isolation_health() ->> 'default_tenant_count')")" 1
echo 'ok 6 ci_tenant_isolation_health: exact counts, no row content, a failing table in scan_errors, anon/authenticated denied, service_role allowed'

# ---------------------------------------------------------------------------
# 7) Guards and rollback R3 → R2 → R1.
# ---------------------------------------------------------------------------
newdb guards
tenants "$db"
run "$db" "$BEFORE"
refused "$db" "$M2" 'apply M1 (20261014000100) first'
q "$db" "INSERT INTO public.tenants (name, slug) VALUES ('Third', 'third')" >/dev/null
refused "$db" "$M1" 'expected exactly 2 tenants'
q "$db" "DELETE FROM public.tenants WHERE slug = 'third'" >/dev/null
q "$db" "CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS \$f\$ BEGIN RETURN NEW; END \$f\$" >/dev/null
run "$db" "$M1"
refused "$db" "$M2" 'handle_new_user() drifted'
eq 'guards: drifted function left untouched' "$(q "$db" "SELECT position('is_default' IN pg_get_functiondef('public.handle_new_user()'::regprocedure))")" 0
echo 'ok 7 guards: M2 refused before M1 and on drift (nothing clobbered), M1 refused unless exactly 2 tenants'

newdb rollback
tenants "$db"
run "$db" "$BEFORE"
catalog "$db" "$WORK/catalog-before.txt"
run "$db" "$M1"; run "$db" "$M2"; run "$db" "$M3"
refused "$db" "$M1" 'tenants.is_default already exists'
refused "$db" "$R1" 'apply rollback-m2.sql first'
run "$db" "$R3"; run "$db" "$R2"; run "$db" "$R1"
catalog "$db" "$WORK/catalog-after.txt"
diff -u "$WORK/catalog-before.txt" "$WORK/catalog-after.txt" || fail 'rollback: R3 → R2 → R1 did not restore the before-state'
run "$db" "$M1"; run "$db" "$M2"
echo 'ok 8 rollback: M1 re-apply refused, R1 refused before R2, R3 → R2 → R1 restores the before-state (md5s, columns, constraints, ACLs), M1+M2 re-apply cleanly'

echo 'PASS vtid-05149 tenant foundation'
