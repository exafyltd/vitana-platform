# VTID-04798 — memory plan phase 3a: role scope and sensitivity on memory rows

Plan: `docs/MEMORY-SYSTEM-PLAN.md` §8.2 and §8.4 phase 3.

Found on the live system (read-only, 2026-10-01):
- Nothing that writes `memory_facts` checked the surface. A Command Hub, admin or BackOffice conversation wrote unscoped personal facts, which the community Vitana then read. The writers were voice extraction, the session-end commit, the remember/forget/recall backstops and Operator Console text.
- Nothing marked GDPR Art. 9 data: 95 of 392 current fact keys (health, medication, sleep, diet, the Vitana Index) and 65 health items.
- The community member ranker matched every member's facts by keyword and showed the matched fact to another member as the reason for a suggestion. It also counted their health-tracking rows (`health_features_daily`).

Changed:
- `services/memory/scope.ts` has one rule, `mayWritePersonalFacts`: a work surface or a work role (`developer`, `admin`, `backoffice`, `commerce`) never writes the member's personal facts.
  - It is checked in `deduplicatedExtract` and the session-end commit.
  - The remember, forget and recall backstops stand down on work surfaces.
  - Operator Console and developer-assistant turns are stamped `active_role='developer'` in `memory_items`.
- Migration `20261001160000_vtid_04798_memory_sensitivity.sql`:
  - `sensitivity` (`standard` | `special_category`) on `memory_facts` and `memory_items`;
  - set in the database from the key by `memory_sensitivity_of`, which only ever raises a row;
  - existing rows backfilled.
- Member ranker: it reads `standard` facts only and no longer reads `health_features_daily`.

- Owner decision 2026-10-01: no personal member memory on the Command Hub. `search_memory` is no longer declared there, the developer persona no longer mentions it, and the live dispatcher refuses it on any work surface.
- Migration applied to the live project with the owner's go (RUN-MIGRATION run 36895020174).

Not in this change (phase 3b): RLS on transaction-local settings, a non-bypass DB role, and a role column on `memory_facts`.

## Acceptance

AC-1: a work-surface conversation (voice, session end, Operator Console text) starts no fact extraction; a member conversation still does.
TEST: services/gateway/test/services/memory/vtid-04798-memory-scope-sensitivity.test.ts

AC-2: the remember, forget and recall backstops run on member surfaces and return nothing on work surfaces.
TEST: services/gateway/test/services/memory/vtid-04798-memory-scope-sensitivity.test.ts

AC-3: the work roles equal the roles the work surfaces serve.
TEST: services/gateway/test/services/memory/vtid-04798-memory-scope-sensitivity.test.ts

AC-4: Art. 9 rows are marked by the database on insert, update and backfill, never lowered by the trigger; the check constraint holds; the migration is idempotent.
TEST: scripts/ci/sql-tests/run-memory-sensitivity-test.sh (CI: SQL-MEMORY-SENSITIVITY.yml)

AC-5: another member is matched on standard facts only, never on health tracking.
TEST: services/gateway/test/services/memory/vtid-04798-memory-scope-sensitivity.test.ts

AC-6: the Command Hub catalog does not declare search_memory, the member catalog does, and the live dispatcher refuses it on a work surface.
TEST: services/gateway/test/services/memory/vtid-04798-memory-scope-sensitivity.test.ts
