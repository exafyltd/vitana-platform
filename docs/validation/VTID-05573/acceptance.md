# VTID-05573 - mt-network-r2 / legacy-messages-migration-db

Plan: `.kiro/specs/mt-network-r2/plan.md` and the `legacy-messages-migration-db` group of `tasks.md` (tasks 1-4). Sparring
record: `plan-sparring.md`.

VALIDATION_PROFILE: gateway_backend (migration files, pgTAP and read-only SQL only).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied from the PR (acceptance is written first; the evidence sections below
are filled when the code is green).

## Acceptance

AC-1 Before anything moves, the four legacy tables (and the two participant tables) are frozen against client and service
writes and copied whole into `bak_*` tables (RLS on, no client grant, 30-day retention note).
TEST: pgTAP cases 3-10 and pglite-harness/checks.sh (freeze).

AC-2 Every legacy message is mapped by the single D15 rule: two people who share a non-platform tenant -> community, tenant =
the shared tenant (their shared primary if several); otherwise network, tenant_id = the sender's context tenant. Groups:
all members share a tenant -> community group of it, else a network group flagged `legacy_scope = network`.
TEST: pgTAP cases 11-35.

AC-3 Rules 43-45: a message to or from a service bot / notification test actor / platform-only account is not migrated, such an
account is never a migrated group member, and the platform tenant is never written on member content.
TEST: pgTAP cases 15, 31, 34, 38, 39.

AC-4 The migration is idempotent and balanced: re-running adds no row, and per source total = migrated + skipped_excluded +
unplaced; the drop file refuses unless unplaced is 0 and every classified row is present.
TEST: pgTAP cases 41-45 and pglite-harness/checks.sh (drop refusal).

AC-5 The four legacy tables are dropped by the last file only; rollback restores them with exact row counts from `bak_*`,
removes the migrated rows, and refuses when a migrated group already received new messages.
TEST: pglite-harness/checks.sh (rollback-check.sql) and cases 1-2.

AC-6 No bare `current_tenant_id()` policy is added; the migration functions are SECURITY DEFINER with a pinned search_path and
EXECUTE for service_role only.
TEST: pgTAP cases 46-47 and the bare-policy lint (jest services/gateway/test/mt-identity-bare-policy-lint.test.ts).
