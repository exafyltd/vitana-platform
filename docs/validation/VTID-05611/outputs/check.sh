#!/bin/sh
# Every object the new DATABASE_SCHEMA.md entries name is created in a migration on main; prints file:line.
cd "$(git rev-parse --show-toplevel)"; M=supabase/migrations; fail=0
chk(){ f=$1; shift; for pat in "$@"; do r=$(grep -nF -- "$pat" $M/$f | head -1); if [ -n "$r" ]; then echo "OK   $f:${r%%:*}  $pat"; else echo "MISS $f  $pat"; fail=1; fi; done; }
chk 20261102053000_vtid_05575_daily_matches_scope.sql "ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'community'" "ADD COLUMN IF NOT EXISTS tenant_id uuid" "daily_matches_scope_check" "idx_daily_matches_scope_tenant"
chk 20261102053100_vtid_05575_daily_matches_guard.sql "FUNCTION public.is_network_candidate" "FUNCTION public.strip_health_match_reasons" "FUNCTION public.daily_matches_scope_guard" "CREATE TRIGGER trg_daily_matches_scope_guard" "network_candidate_not_visible" "no_shared_tenant" "active_member"
chk 20261102053200_vtid_05575_intent_matchers_scope.sql "FUNCTION public.intent_pool_allows" "search_intent_catalog(uuid" "search_intent_catalog_v2(uuid" "compute_intent_matches(uuid" "compute_intent_matches_v2(uuid" "DEFAULT ''community''"
chk 20261102052000_vtid_05573_legacy_messages_snapshot_freeze.sql "CREATE TABLE public.%I (LIKE public.%I" "interval '30 days'" "ENABLE ROW LEVEL SECURITY" "GRANT SELECT ON public.%I TO service_role" "REVOKE INSERT, UPDATE, DELETE, TRUNCATE" "'thread_participants', 'global_thread_participants'" "pre-freeze-acl="
chk 20261102052100_vtid_05573_legacy_messages_functions.sql "FUNCTION public.mt_legacy_common_tenant" "FUNCTION public.mt_legacy_context_tenant" "FUNCTION public.mt_legacy_messages_migrate" "FUNCTION public.mt_legacy_messages_assert_ready" "legacy_scope"
chk 20261102052200_vtid_05573_legacy_messages_migrate_run.sql "SELECT public.mt_legacy_messages_migrate()"
chk 20261102052300_vtid_05573_legacy_messages_drop.sql "DROP TABLE IF EXISTS public.global_messages" "DROP TABLE IF EXISTS public.messages" "DROP TABLE IF EXISTS public.global_message_threads" "DROP TABLE IF EXISTS public.message_threads" "SELECT public.mt_legacy_messages_assert_ready()"
# the 05569 section is no longer split: the connections_social line sits directly under 'New member categories'
awk '/New member categories/{getline n; if (n ~ /connections_social/) print "OK   notification entry holds the connections_social line"; else {print "MISS line not under New member categories"; exit 1}}' DATABASE_SCHEMA.md
# no other text changed: removed lines are only the 3 moved ones (plus blank)
git diff origin/main -- DATABASE_SCHEMA.md | grep '^-[^-]' | sed 's/^-//' ; echo "(above = every removed line)"
exit $fail
