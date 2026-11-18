# Sparring round 1 — in_progress

Session: `d71fc777-ea2f-4e03-babe-aaefa97b9429` · plan hash `034904b92a2e64e3f581ab2f87befedecc02e6c654c800d5bc40e9151ed7f93c`

## Summary

The plan is well-structured and most premises verified cleanly against the pinned commit. Three lanes, each touching one file, all docs/test-only as declared. The key gap is that the plan adds new queue rows (for VTID-05575, and conditionally VTID-05573) whose migrations depend on VTID-05582 (`20261102051000`/`051100`), yet the plan explicitly defers adding 05582's queue rows—even though 05582's migration and validation files are fully merged on main. This compounds the existing queue debt rather than reducing it, and creates rows with dependencies that can't be traced within the queue.

## Findings

### R1-F1 [major]

The plan adds queue rows for VTID-05575 (rows 48-50) and conditionally VTID-05573 (rows 53-56), but defers adding rows for VTID-05582 despite 05582's migrations being fully on main. The VTID-05575 migration 053100 explicitly states 'Depends on VTID-05582 (20261102051000: network_visible, is_network_excluded_account)' (line 20-21), and 053200 similarly depends on 05582 (line 24). The VTID-05573 rows also declare a dependency on `20261102051000`. Adding queue rows whose 'Depends on' column points to migrations not tracked in the queue breaks the queue's own mandate ('Every concurrent multi-tenant lane adds its migrations here'). Since 05582's files and validation artifacts are already on main, adding its two rows is straightforward and should be in scope, not deferred.

- `exafyltd/vitana-platform:supabase/migrations/20261102053100_vtid_05575_daily_matches_guard.sql:20` — -- Depends on VTID-05582 (20261102051000: network_visible, is_network_excluded_account). The functions are plpgsql, so this file
-- applies without it; a network row then errors until it exists.
- `exafyltd/vitana-platform:supabase/migrations/20261102053200_vtid_05575_intent_matchers_scope.sql:24` — -- Depends on 20261102053100 (is_network_candidate) and VTID-05582.
- `exafyltd/vitana-platform:supabase/migrations/20261102051000_vtid_05582_network_visible_profile.sql:1` — -- VTID-05582 (mt-network-r2/network-visibility-db) N1: global_community_profiles.network_visible and the rule-45 guard.
- `exafyltd/vitana-platform:docs/multitenancy/MIGRATION-QUEUE.md:4` — created by VTID-05149 (lane A). **Every concurrent multi-tenant lane adds its
migrations here in the same PR that adds the files**, in the position it must be
applied.

Suggestion: Bring VTID-05582's two queue rows (for `20261102051000` and `20261102051100`) into the `migration-queue-rows` lane alongside the 05575 rows. The migration files and full validation artifacts (rollback scripts, acceptance.md, pglite harness) are already on main, so the row content is derivable. Place them between row 47 (050200) and the new 05573/05575 rows in table order, matching their timestamp sort position.

### R1-F2 [minor]

The proposed row numbering places rows 53-56 (VTID-05573) physically before rows 48-50 (VTID-05575) in the table. Combined with the existing 51-52 after 47, the visual sequence becomes ...47, 53, 54, 55, 56, 48, 49, 50, 51, 52. While the plan acknowledges row numbers are labels, this degree of non-monotonicity makes the queue harder to follow and auditing harder. With four new blocks being inserted, this is an opportunity to renumber.

- `exafyltd/vitana-platform:docs/multitenancy/MIGRATION-QUEUE.md:87` — - Rows 51-52 (VTID-05569, mt-data-cleanup-r2/hot-tables-not-null-expand-contract) run last in the mt-data-cleanup-r2 spec, after the orphan lane (rows 21-25), the memory-facts merge (rows 37-39) and the profiles backfill (rows 41-42). The lane's range is `20261102043000-043999`. Rows 48-50 are reserved for VTID-05575; row numbers may shift at landing.

Suggestion: Consider renumbering so all new and existing rows in the 47-52 area are monotonic in table position. For example: 47 (05576 N1c), 48-49 (05582), 50-53 (05573), 54-56 (05575), 57-58 (05569). The closing note already says 'row numbers may shift at landing', so a clean renumber now avoids compounding confusion.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
