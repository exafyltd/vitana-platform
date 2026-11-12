# VTID-05611 - mt-schema-queue-followup-r2 / schema-entries

Plan: `.kiro/specs/mt-schema-queue-followup-r2/plan.md` and the `schema-entries` group of `tasks.md` (S1-S4).

VALIDATION_PROFILE: gateway_backend (documentation only: `DATABASE_SCHEMA.md` and this evidence folder).
ROUTE_MOUNT: none. FINAL_URL: n/a. Nothing is applied and no SQL ran against any live system.

Change types: Tooling/docs.

## Files

| Task | File |
|---|---|
| S1 notification entry no longer split | `DATABASE_SCHEMA.md` |
| S2 VTID-05575 section | `DATABASE_SCHEMA.md` |
| S3 VTID-05573 section (PR #4840 is on `main`, 2c1a3d23ad) | `DATABASE_SCHEMA.md` |
| S4 evidence | `docs/validation/VTID-05611/**` |

## Acceptance

AC-1 (S1) The `connections_social` / `new_follower` line and the `**Rules:**` paragraph sit in the VTID-04674 notification entry
again; the VTID-05569 section follows that entry's closing `---`, intact and unsplit. Only these three moved lines are removed from
their old place; no other existing text changes.
TEST: `outputs/check.sh` last two checks (line under "New member categories"; the removed-lines list) -> `outputs/check-output.txt`.

AC-2 (S2) The VTID-05575 section names `daily_matches.scope`, `tenant_id`, `daily_matches_scope_check`, `idx_daily_matches_scope_tenant`,
the functions `is_network_candidate`, `strip_health_match_reasons`, `daily_matches_scope_guard`, `intent_pool_allows`, the trigger
`trg_daily_matches_scope_guard`, and the in-place replacement of the four intent matchers; each is created in a migration file on `main`.
TEST: `outputs/check.sh` sections for `20261102053000`, `053100`, `053200` (file:line per object) -> `outputs/check-output.txt`.

AC-3 (S3) The VTID-05573 section names the `bak_*` snapshot tables (dynamic SQL, 30-day retention, RLS on, service_role read only),
the freeze, the four dropped tables `messages`, `message_threads`, `global_message_threads`, `global_messages`, the two
participant tables that stay frozen, and the four `mt_legacy_*` functions; each is in a migration file on `main`.
TEST: `outputs/check.sh` sections for `20261102052000`, `052100`, `052200`, `052300` (file:line per object) -> `outputs/check-output.txt`.

AC-4 (states) Every new entry says the migrations are committed and not applied.
TEST: `grep -c "NOT applied" DATABASE_SCHEMA.md` includes both new headings (see `commands.log`).

AC-5 (scope) The PR changes only `DATABASE_SCHEMA.md` and `docs/validation/VTID-05611/**`.
TEST: `scope.json` paths and the Lane scope / PR-GATE checks of preflight (see `commands.log`).

Locales: n/a, English-only internal doc. Accessibility: n/a. Staging proof: not verified on staging (docs only).
