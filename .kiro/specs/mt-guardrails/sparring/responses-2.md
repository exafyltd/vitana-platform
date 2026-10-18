# Sparring responses — round 2
```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Correct and verified: .github/workflows/SQL-TENANT-FOUNDATION.yml:32 uses a plain postgres:16 service with no pgtap and no install step, so the plan's 'same pgtap/pg_prove versions pinned across local and CI' claim had no stated mechanism. Fixed by naming ONE concrete, pinned mechanism used verbatim by both lane 1 (local-test-stack) and lane 6 (ci-wiring, executor claude): the Postgres server comes from the supabase/postgres image pinned by exact tag — which ships the pgtap extension, unlike stock postgres:16 (confirmed: supabase/postgres compiles pgtap in at build time) — and pg_prove is installed from a pinned libtap-parser-sourcehandler-pgtap-perl apt version on the host that runs the suite. The image carries the server-side extension (there is no runtime mechanism to add a compiled extension to stock postgres:16), and pg_prove is a Perl TAP harness that runs on the runner/dev host over external psql, so the two pieces are installed by their correct layer. Lane 1 brings the stack up from the pinned image and installs the pinned pg_prove; lane 6's SQL-MT-ISOLATION.yml declares the same pinned image as its Postgres service and installs the same pinned pg_prove — one shared contract, recorded in both lane bodies, both tasks (T4, C3) and the plan Risks/Tests/Fix sections. Chosen over apt-get postgresql-16-pgtap into the stock image because the extension must live in the server and the image path is the smaller, deterministic change that keeps the postgres-service shape of the SQL-TENANT-FOUNDATION analogue.",
    "deferred_to": ""
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Correct and verified: scripts/ci/pr-gate/config.json's enforce flag is read only by PR-GATE.yml's Verdict step, which fails solely on the OUTCOMES list — scope, kiro-steering, sparring, weakening, red-green (PR-GATE.yml:106); the Collab handoff step is report-only purely by being continue-on-error:true and absent from OUTCOMES (PR-GATE.yml:62). The new WS0 checks follow the SQL-TENANT-FOUNDATION.yml shape — standalone workflows that fail hard with no report-only mode and are entirely outside config.json — so 'report-only via PR-GATE config.json' was unjustified for them. Fixed by choosing path B explicitly and naming the concrete flip target: each new standalone workflow (MT-GUARDRAILS.yml for the inventory/lint/gateway/golden checks, and a dedicated SQL-MT-ISOLATION.yml for the pgTAP suite) reads its OWN scripts/ci/mt/config.json report_only flag (default true) and, while true, emits a warning annotation and exits 0 even on assertion failure; the flip to enforcing is a later governance PR that sets report_only=false in scripts/ci/mt/config.json. ci-wiring is executor: claude (governance), and this is stated in the plan Fix/Rollout/Tests sections, tasks C1/C3, and the ci-wiring lane body so the governance flip has a mechanically verifiable target.",
    "deferred_to": ""
  },
  {
    "finding_id": "R2-F3",
    "disposition": "accepted",
    "rationale": "Correct and verified: SQL-TENANT-FOUNDATION.yml:17 watches scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql and the runner at run-tenant-foundation-test.sh:23 reads the fixture from scripts/ci/sql-tests/, i.e. the VTID-05149 analogue co-locates spec and runner there, while supabase/tests/ is the initdb/pg_ctl convention (vtid_05147_s_m_lockdown.test.sql:1). The revision's hybrid — runner in scripts/ci/sql-tests/ but spec in supabase/tests/mt/** — matched neither. Fixed by placing the pgTAP spec at scripts/ci/sql-tests/mt-isolation.test.sql, beside scripts/ci/sql-tests/run-mt-isolation-test.sh, so the new SQL-MT-ISOLATION.yml paths: trigger stays on scripts/ci/sql-tests/** exactly like every other SQL-*.yml. The isolation-suite lane's front-matter paths and its tasks.md Allowed paths are both updated to the two co-located files (scripts/ci/sql-tests/mt-isolation.test.sql and scripts/ci/sql-tests/run-mt-isolation-test.sh) so they match exactly, and the plan body (lane 3) and P1/P3 are updated to the new location. pgTAP itself is unchanged — still REQUIRED by the hash-locked parent docs/MULTI-TENANT-PLAN.md §4.2/§4.9; only the file location moved.",
    "deferred_to": ""
  }
]
```
