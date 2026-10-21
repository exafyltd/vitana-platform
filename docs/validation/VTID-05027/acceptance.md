# VTID-05027 — acceptance

AC-1 `push_reach_active(p_days)` returns active / eligible / reached member counts over the window, excluding `notification_test_actors` and `service_bot_accounts`; suppressed_* outcomes are not eligible; EXECUTE for service_role only.
TEST: supabase/migrations/20261010120000_vtid_05027_push_reach_active.sql — gate migrations lint + libpg-query parse; function body run read-only against current data (outputs/local-checks.txt: active 16, eligible 15, reached 14)

AC-2 `/ops/health/push-dispatch` reports `active_reach_7d {active, eligible, reached, ratio}` from the RPC (7 days).
TEST: services/gateway/test/vtid-05027-push-reach-health.test.ts ("reach is reported with its ratio", "calls push_reach_active for 7 days and reports active_reach_7d")

AC-3 Degraded `active_member_reach_low` when eligible >= 10 and ratio < 0.9; exactly 0.9 and fewer than 10 eligible stay ok; backlog and FCM-error checks win first.
TEST: services/gateway/test/vtid-05027-push-reach-health.test.ts

AC-4 RPC error or missing function → field omitted, no false alarm; existing behaviour without reach unchanged.
TEST: services/gateway/test/vtid-05027-push-reach-health.test.ts ("RPC error (e.g. not migrated) → field omitted, still ok"), services/gateway/test/vtid-04962-push-health.test.ts, services/gateway/test/vtid-04663-ops-health-checks.test.ts

OASIS_IMPACT: no new OASIS topics or event shapes.
