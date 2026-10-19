# Responses — round 2 (session 496d49e4)

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Verified: SQL-TENANT-FOUNDATION.yml:33, SQL-HEALTH-STORE.yml:25 and SQL-MEMORY-SENSITIVITY.yml:23 all use the floating postgres:16, and the plan named no actual pin. Fixed with a 'Pinned versions' table in plan.md that both lanes copy verbatim: image supabase/postgres:17.4.1.074 (the exact version production reports, docs/SUPABASE-SECURITY-ADVISOR-AUDIT-2026-08-28.md:60 'supabase-postgres-17.4.1.074'; tag confirmed on Docker Hub) with its index digest sha256:dc436b5b4ebeb0f3bdf6d8dda2b390cc094e14d24cd434d5fe02840459e67670 recorded as a re-push guard; pg_prove from libtap-parser-sourcehandler-pgtap-perl=3.36-2 (the version published in Ubuntu 24.04 noble/universe); and, because that apt version exists only on noble, the OS is pinned too: CI runs-on ubuntu-24.04 (not ubuntu-latest) and locally pg_prove runs in an ubuntu:24.04 container. tasks.md T4/C3 and lanes local-test-stack and ci-wiring now carry the literal strings, and ci-wiring's workflow-shape test asserts the workflow uses exactly those literals.",
    "deferred_to": null
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Verified: SQL-HEALTH-STORE.yml:43, SQL-MEMORY-SENSITIVITY.yml:40 and SQL-TENANT-FOUNDATION.yml:51 are all 'run script | tee log' then 'grep -q ^PASS', with no config reading anywhere. Fixed by specifying one contract in plan.md lane 6: each check step gets an id and continue-on-error: true; the next step (if: always()) runs node scripts/ci/mt/report-gate.mjs --outcome \"${{ steps.<id>.outcome }}\" [--log <file> --expect '<regex>']. The helper reads scripts/ci/mt/config.json {\"report_only\": true}: the check passed iff outcome is success and the log matches --expect; passed -> exit 0; failed + report_only true -> ::warning annotation + exit 0; failed + false -> ::error + exit 1; missing/unparsable/non-boolean config -> exit 1 (fail loud). The isolation runner prints 'PASS mt-isolation' last only after pg_prove exits 0, so SQL-MT-ISOLATION.yml uses --expect '^PASS mt-isolation', keeping the existing grep-for-PASS semantics. Tests are no longer self-referential: report-gate.test.mjs exercises the five cases against temp config files, and a workflow-shape test asserts every check step is continue-on-error and followed by a report-gate.mjs step. The helper lives in scripts/ci/mt/**, already in ci-wiring's paths; tasks C1/C3/P3 and the ci-wiring and isolation-suite lane bodies updated.",
    "deferred_to": null
  }
]
```
