# VTID-04765 — account deletion left memory, diary and health data behind

`request-account-deletion` (vitana-v1) deleted 20 hand-listed tables and then the auth user. Measured read-only on the live schema 2026-10-01: about 200 more public tables have a `user_id` with no ON DELETE CASCADE to `auth.users`. Among them are `memory_facts` (11.9k rows), `memory_items`, `mem_facts`, `memory_transcript_turns`, `user_assistant_state`, `diary_entries`, `health_features_daily`, `vitana_index_scores`, the biomarker and wearable tables, `calendar_events` and `user_notifications`. Their rows outlived the account.

Fix:
- `erase_user_data(user_id)` finds the tables itself, so a new table is covered on the day it ships.
- It keeps only `erasure_registry` entries, each with a written reason.
- It leaves auth-cascading tables to the auth delete.
- It retries foreign-key order and reports every table it could not erase.
- The edge function deletes the account only when the erasure finished without errors (vitana-v1 PR, same VTID).

Found while testing against the live foreign keys (read-only):
- `wallet_accounts` is referenced by the retained ledgers, so it is retained too.
- `profiles` and `app_users` are referenced by tables with no `user_id`, so they are left to the auth cascade.
- Otherwise those deletes would fail every time and block every account deletion.

## Acceptance

AC-1: A's rows are gone from plain, partitioned and FK-ordered tables, and rows a delete trigger wrote are swept as well. User B is untouched.
TEST: scripts/ci/sql-tests/vtid-04765-erase-user-data.test.sql

AC-2: retained tables keep their rows and are reported. Auth-cascading tables are not touched. A failing table is reported, not swallowed. A null user is refused.
TEST: scripts/ci/sql-tests/vtid-04765-erase-user-data.test.sql

AC-3: only service_role can execute; a dry run counts and deletes nothing.
TEST: scripts/ci/sql-tests/vtid-04765-erase-user-data.test.sql

AC-4 (vitana-v1): the account is deleted only when erase_user_data reports no errors. The pre-migration PGRST202 case keeps the old behaviour and is logged.
TEST: vitana-v1 src/lib/erase-user-data.test.ts

## Not covered
- Columns other than `user_id` (`sender_id`, `author_id`, ...): still the edge function's own list.
- `account_deletion_requests` cascades from `auth.users`, so the record of the request is deleted with the account. That is pre-existing; the plan (VTID-04767) moves the audit to a non-cascading row.
- The retain list (HGB §257 / AO §147) needs counsel's confirmation.
- Apply order: migration (RUN-MIGRATION.yml), then the edge function deploy.
