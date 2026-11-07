# Sparring round 2 — converged

Session: `d71fc777-ea2f-4e03-babe-aaefa97b9429` · plan hash `738d435ce747058a0aacb092fa845fed1e8aa89a43b0f9552ac39a2eb62e8d02`

## Summary

Both R1-F1 and R1-F2 were accepted and properly addressed in the revised plan: VTID-05582 rows 48-49 are now in scope, and the renumbering makes the sequence monotonic (48-49, 50-53, 54-56, 57-58). The remaining premises I could verify hold. One new minor finding on overstated dependencies in the planned queue rows.

## Findings

### R2-F1 [minor]

The plan states '05575 rows depend on rows 48 (05582) and 45 (05576)' and '05573 rows on rows 45 and 48'. However, none of the three 05575 migration files declare any dependency on VTID-05576. 053000 (daily_matches_scope) has no stated dependency at all (expand-only). 053100 says 'Depends on VTID-05582 (20261102051000)'. 053200 says 'Depends on 20261102053100 and VTID-05582'. VTID-05576 (chat_messages scope) is functionally unrelated to daily_matches and intent matchers. The queue's 'Depends on' column records functional dependencies (as visible in every existing row), not just sort-order position. Overstating them could mislead rollback planning (e.g., someone concluding that rolling back 05576 requires first rolling back 05575).

- `exafyltd/vitana-platform:supabase/migrations/20261102053000_vtid_05575_daily_matches_scope.sql:1` — -- Dark: nothing reads the columns before the write guard (20261102053100) and the scoped recompute. Expand only.
-- Safe to re-run.
- `exafyltd/vitana-platform:supabase/migrations/20261102053100_vtid_05575_daily_matches_guard.sql:20` — -- Depends on VTID-05582 (20261102051000: network_visible, is_network_excluded_account). The functions are plpgsql, so this file
-- applies without it; a network row then errors until it exists.
- `exafyltd/vitana-platform:supabase/migrations/20261102053200_vtid_05575_intent_matchers_scope.sql:24` — -- Depends on 20261102053100 (is_network_candidate) and VTID-05582.
- `exafyltd/vitana-platform:docs/multitenancy/MIGRATION-QUEUE.md:63` — | 45 | `20261102050000_vtid_05576_chat_messages_scope.sql` | mt-network-r2/messaging-send-db / VTID-05576 (N1) |

Suggestion: Set the 'Depends on' for the three 05575 rows to match the migration files: row 54 (053000) = '— (expand only)'; row 55 (053100) = '#54, #48 (VTID-05582 051000)'; row 56 (053200) = '#55, #48 (VTID-05582)'. Drop the dependency on row 45 (05576). For the 05573 rows, derive the column from the 05573 migration file headers once PR #4840 lands rather than pre-declaring a dependency on 05576.
