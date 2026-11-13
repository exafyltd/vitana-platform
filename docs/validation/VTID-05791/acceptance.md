# VTID-05791 — plan sparring wording acceptance
Change types: Tooling/docs

Outcome: the VTID-04868 session-layer test asserts CLAUDE.md rule 51 with the current wording "machine approval on convergence", and every other assertion in that test file still holds.
States: the one assertion line changed from "machine approval" to "machine approval on convergence"; no test name, expectation or other file changed.
Surfaces: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts (test only; no runtime, route, schema or deploy change).
Locales: n/a. Accessibility: n/a.
Staging proof: not verified on staging: test-only change with no runtime path. The suite is a Jest unit test run in gateway CI.

AC-1 — the rule 51 assertion matches the CLAUDE.md rule 51 wording "machine approval on convergence" (rule 51 reads "plan → sparring → machine approval on convergence (…) → VTID → code")
  TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts (CLAUDE.md carries rules 51-55 and puts allocation after sparring)

AC-2 — the partner agent is read-only and pinned to Opus 4.6, unchanged by this VTID
  TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts (the partner agent is read-only and pinned to Opus 4.6)

AC-3 — the skill defines at least two sparring passes, round caps and the record location, unchanged by this VTID
  TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts (the skill defines >=2 passes, round caps and the record location)

AC-4 — the PreToolUse hook denies an allocation that references no sparring record, before it runs
  TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts (hook DENIES an allocation that references no sparring record (before it runs))

AC-5 — the PreToolUse hook also denies /vtid/allocate and direct ledger inserts, including multi-line SQL
  TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts (hook also denies /vtid/allocate and direct ledger inserts, including multi-line SQL)

AC-6 — the hook allows a call that references a sparring record and ignores unrelated commands
  TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts (hook allows the call when a sparring record is referenced, and ignores unrelated commands)

AC-7 — settings.json registers the hook for Bash and execute_sql
  TEST: services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts (settings.json registers the hook for Bash and execute_sql)
