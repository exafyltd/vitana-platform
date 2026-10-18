# Sparring responses — round 1
```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Correct. The plan proposed pgTAP + pg_prove, but supabase/tests/ uses only the raw-psql + RAISE pattern (\\set ON_ERROR_STOP 1, *.test.sql specs run by a scripts/ci/test-*.sh runner that spins up a throwaway Postgres via initdb/pg_ctl) — e.g. supabase/tests/vtid_05147_s_m_lockdown.test.sql driven by scripts/ci/test-vtid-05147-s-m-lockdown.sh. A git grep for pgtap/pg_prove returns zero hits anywhere in either repo, so pgTAP would be a second competing SQL-test framework in the same directory. Resolution: the isolation suite uses the existing raw-psql + RAISE harness, not pgTAP, so there is one SQL-test harness. The lane is renamed pgtap-isolation-suite -> isolation-suite consistently (lane file lanes/isolation-suite.md with paths supabase/tests/mt/** + scripts/ci/test-mt-isolation.sh; tasks.md marker, heading, Allowed paths and P1/P3; handoff.md lane bullet; and lanes/ci-wiring.md depends_on + C1/C3). The health tables are covered via the shared health-table-list constant created by lane 2 (generated-inventories) from MULTI-TENANT-PLAN.md section 2, switching to mt-identity's isHealthTable() when it ships — never a scattered local copy; lane 3 now depends_on generated-inventories.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Correct, and verified: the npm scripts test:support (rule 42c), test:operator (rule 42e) and test:roles (rule 42h) all exist in services/gateway/package.json, so the maxina-golden-suite and gateway-scope-lint-contract lanes' reliance on them is a real dependency, not an unverified promise. The plan's Tests section now cites that verification. The companion row-21b observation is also accepted: MORNING-SYSTEM-HEALTH-CHECK.yml:546 binds SUPABASE_URL to secrets.SUPABASE_URL directly while rows 5-12/21 use vars.DATA_REST_URL || secrets.SUPABASE_URL; the plan documents this pre-existing discrepancy and folds the one-line alignment fix into the ci-wiring lane (executor: claude, since it edits .github/workflows/).",
    "deferred_to": ""
  }
]
```
