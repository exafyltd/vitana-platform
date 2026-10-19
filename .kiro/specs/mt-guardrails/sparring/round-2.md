# Sparring round 2 — in_progress

Session: `496d49e4-e3b5-4421-86d0-edaa18ddb659` · plan hash `84ba14e712975c7e1bee81ebc36af98c5990f462f748932f49f1fd5bfe1126df`

## Summary

All three round-1 findings were accepted and are properly addressed in the revised plan. Two new major gaps are present in the revision: (1) the supabase/postgres image tag and pg_prove apt package version are declared "pinned" but no actual values are given, leaving two independent executors to choose different pins; (2) the report_only flag mechanism for the new SQL-*.yml workflows is wholly unspecified and has no prior art in the existing SQL-*.yml codebase.

## Findings

### R2-F1 [major]

The plan says lane 1 and lane 6 use 'the identical install mechanism: pinned `supabase/postgres` image + pinned `pg_prove` apt version, named verbatim'. No actual image tag or apt package version appears anywhere in the plan. Without explicit values, two independent executors (lane 1: kiro; lane 6: claude) will each independently choose a tag that satisfies 'pinned by exact tag' and may choose differently, breaking the determinism guarantee. Every existing SQL-*.yml pins `postgres:16` as a floating tag; this spec requires a stricter digest/minor-version pin for `supabase/postgres` but supplies no string to copy.

- `exafyltd/vitana-platform:.github/workflows/SQL-TENANT-FOUNDATION.yml:33` — services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
- `exafyltd/vitana-platform:.github/workflows/SQL-HEALTH-STORE.yml:25` — services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
- `exafyltd/vitana-platform:.github/workflows/SQL-MEMORY-SENSITIVITY.yml:23` — services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres

Suggestion: Add an explicit 'Pinned versions' table to the plan with e.g. `supabase/postgres:15.8.1.020` and `libtap-parser-sourcehandler-pgtap-perl=3.35-3` (or whatever the chosen values are). Both lane 1 and lane 6 copy these verbatim strings from the plan. The plan's own risk section calls this pinning the single determinism mechanism — supply the values that make it actionable.

### R2-F2 [major]

The plan says 'each new workflow reads a committed `scripts/ci/mt/config.json` `report_only` flag (default `true`) and, while true, warns-and-exits-0 even on failure', and the Tests section requires 'a test asserts each new `SQL-*.yml` honours the flag'. But all three existing SQL-*.yml workflows use an identical two-step pattern — run the shell script, then `grep -q '^PASS …'` — with no JSON config reading anywhere. The plan specifies no mechanism for how the YAML reads the flag (GitHub Actions `fromJSON` expression? a bash jq step? a Node.js helper?) nor how 'warn-and-exit-0' overrides the grep-for-PASS step. Without a specified mechanism the test ('asserts each new SQL-*.yml honours the flag') is self-referential: it tests whatever lane 6 invents rather than a defined contract.

- `exafyltd/vitana-platform:.github/workflows/SQL-HEALTH-STORE.yml:43` —           run: |
            set -o pipefail
            scripts/ci/sql-tests/run-health-store-test.sh 2>&1 | tee /tmp/health-store.log
        - name: Assert the test ran to the end
          run: |
            grep -q '^PASS vtid-05158 health store' /tmp/health-store.log
            grep -q '^PASS vtid-05158 placement guard' /tmp/health-store.log
- `exafyltd/vitana-platform:.github/workflows/SQL-MEMORY-SENSITIVITY.yml:40` —           run: |
            set -o pipefail
            scripts/ci/sql-tests/run-memory-sensitivity-test.sh 2>&1 | tee /tmp/sensitivity.log
        - name: Assert the test ran to the end
          run: grep -q '^PASS vtid-04798 memory sensitivity' /tmp/sensitivity.log
- `exafyltd/vitana-platform:.github/workflows/SQL-TENANT-FOUNDATION.yml:51` —           run: |
            set -o pipefail
            bash scripts/ci/sql-tests/run-tenant-foundation-test.sh 2>&1 | tee /tmp/tenant-foundation.log
        - name: Assert the test ran to the end
          run: grep -q '^PASS vtid-05149 tenant foundation' /tmp/tenant-foundation.log
- `exafyltd/vitana-platform:scripts/ci/aurora-migration-inventory.cjs:1` — #!/usr/bin/env node
/**
 * VTID-03494 — inventory the Supabase surface

Suggestion: Specify the mechanism in the lane 6 spec. The simplest approach consistent with existing workflows: (1) the workflow YAML adds a step before the runner that executes `echo "REPORT_ONLY=$(jq -r .report_only scripts/ci/mt/config.json)" >> $GITHUB_ENV`; (2) the 'Assert the test ran to the end' step is wrapped in `if: env.REPORT_ONLY != 'true'` with a parallel step emitting `::warning::` when it is true; (3) the `node --test` self-test mocks the JSON file and asserts both exit codes. State this mechanism in the plan so the implementer and test author share the same contract.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Properly addressed. The revised plan explicitly states: dump is pg_dump --schema=public --schema-only, enforced by the regenerate script which refuses any other --schema; auth/storage/realtime never re-created; fixtures INSERT into the existing auth.users — never CREATE it (with an explicit contrast to vtid-05149-tenant-foundation.test.sql:13 which CREATEs auth.users because it runs on postgres:16); smoke test asserts to_regclass('auth.users') is non-null before fixtures load.
- R1-F2: acknowledged — Properly addressed. The revised plan now says SQL-MT-ISOLATION.yml's paths: uses the scripts/ci/sql-tests/** glob like SQL-HEALTH-STORE.yml/SQL-MEMORY-SENSITIVITY.yml, not SQL-TENANT-FOUNDATION.yml's per-file list. Both reference workflows confirmed to use the glob.
- R1-F3: acknowledged — Properly addressed. The revised plan requires run-mt-isolation-test.sh to start with the PGHOST guard copied verbatim from run-tenant-foundation-test.sh:18-20 (pattern *supabase*|*amazonaws*|*rds*, exit 2); Tests section adds a case asserting PGHOST=x.supabase.co exits 2 before connecting; lane 6 states SQL-MT-ISOLATION.yml's PGHOST is only the service container, never a live endpoint.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
