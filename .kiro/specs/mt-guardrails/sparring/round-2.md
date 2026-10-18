# Sparring round 2 — in_progress

Session: `e7f1e151-ad1e-46c8-9a28-5e9f53d72117` · plan hash `1a917310ee314d11c61e61ff2642889e3db7632806df93a45160a614a17e5616`

## Summary

All three R1 findings were accepted and addressed in the revision. Two major and one minor new finding arise from the revision itself. The most critical new gap is that pgTAP/pg_prove installation mechanism is completely unspecified: the plan's closest CI analogue (SQL-TENANT-FOUNDATION.yml) uses postgres:16 with no pgTAP and gives no apt/cpan/image guidance; the "same versions pinned across local and CI" determinism guarantee the plan promises is therefore unjustified. The second major gap is a governance hole: the "report-only first" claim relies on the PR-GATE config.json enforce flag, but that flag only controls checks wired into PR-GATE.yml's Verdict OUTCOMES — standalone SQL/shell workflows (the kind the new CI checks will produce) are entirely outside that mechanism. A minor inconsistency is also introduced by the resolution of R1-F1: the revised plan places pgTAP spec files in supabase/tests/mt/ while the runner goes into scripts/ci/sql-tests/, a hybrid that matches neither the VTID-05149 analogue (both runner and SQL in scripts/ci/sql-tests/) nor the vtid-05147 pattern (SQL in supabase/tests/, runner uses initdb/pg_ctl).

## Findings

### R2-F1 [major]

The plan asserts 'lane 1 pins pgtap/pg_prove versions in the local-stack setup and ci-wiring installs the same versions in the job, so the suite is deterministic across local and CI' but never specifies the installation mechanism. The closest CI analogue — SQL-TENANT-FOUNDATION.yml, which the plan explicitly endorses as the model for the isolation suite runner location — uses a plain postgres:16 service container with zero additional installation steps and no pgTAP. pgTAP requires two distinct packages: (a) the pgtap PostgreSQL extension (e.g. apt-get install postgresql-16-pgtap, or a pgtap-enabled Docker image), and (b) the pg_prove Perl tool (e.g. libtap-parser-sourcehandler-pgtap-perl or CPAN). Neither is present in postgres:16. Without specifying the mechanism, the two implementers (lane 1/kiro and lane 6/ci-wiring/claude) have no shared contract; they can independently choose different images or install different versions, breaking the 'same versions' determinism guarantee the plan offers as its key risk mitigation for introducing pgTAP for the first time.

- `exafyltd/vitana-platform:.github/workflows/SQL-TENANT-FOUNDATION.yml:32` — services:
        postgres:
          image: postgres:16
          env:
            POSTGRES_PASSWORD: postgres
          ports: ['5432:5432']
          options: >-
            --health-cmd pg_isready
- `exafyltd/vitana-platform:.github/workflows/SQL-TENANT-FOUNDATION.yml:45` —       - name: Run the tenant foundation test
          env:
            PGHOST: 127.0.0.1
            PGPORT: '5432'
            PGUSER: postgres
            PGPASSWORD: postgres
          run: |
            set -o pipefail
            bash scripts/ci/sql-tests/run-tenant-foundation-test.sh 2>&1 | tee /tmp/tenant-foundation.log

Suggestion: Add a concrete, pinned installation block to the plan for both environments. For CI: specify whether ci-wiring uses `apt-get install postgresql-16-pgtap libtap-parser-sourcehandler-pgtap-perl` (with pinned package versions) or switches to a pgtap-capable Docker image (e.g. supabase/postgres which ships pgtap). For the local stack: specify the same mechanism in the local-stack setup script. Both lanes must reference the same specification so the 'same versions' guarantee is verifiable before implementation begins.

### R2-F2 [major]

The plan states 'New CI checks land report-only first (PR-GATE scripts/ci/pr-gate/config.json pattern) and are flipped to enforcing by a later governance change.' But the config.json enforce flag only controls checks wired into PR-GATE.yml's Verdict OUTCOMES variable — currently scope, kiro-steering, sparring, weakening, and red-green. The established pattern for a report-only check inside PR-GATE.yml is 'continue-on-error: true on the step plus absent from OUTCOMES', as the Collab handoff step demonstrates. Standalone SQL/shell workflows — the type of workflow the new WS0 checks (SQL-MT-ISOLATION.yml, MIGRATION-QUEUE-LINT.yml) will follow, given their analogue is SQL-TENANT-FOUNDATION.yml — are separate GitHub Actions workflows entirely unaffected by config.json. SQL-TENANT-FOUNDATION.yml has no report-only mode: it fails hard from day one. Without specifying whether new checks go into PR-GATE.yml as steps or as standalone workflows, the 'flip to enforcing by a later governance change' commitment is unjustified, because standalone workflows have no enforce flag to flip.

- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:106` —           OUTCOMES: >-
            scope=${{ steps.scope.outcome }}
            kiro-steering=${{ steps.kirosteering.outcome }}
            sparring=${{ steps.sparring.outcome }}
            weakening=${{ steps.weakening.outcome }}
            red-green=${{ steps.redgreen.outcome }}
- `exafyltd/vitana-platform:.github/workflows/PR-GATE.yml:62` —         # VTID-05145: ... Report-only until 2026-10-20:
        # it is not in the Verdict OUTCOMES yet; add `collab=${{ steps.collab.outcome }}` there to make it count.
        - name: Collab handoff
          id: collab
          continue-on-error: true
- `exafyltd/vitana-platform:scripts/ci/pr-gate/config.json:1` — {
  "enforce": false,
  "note": "VTID-04950: PR-GATE starts report-only (plan rollout: 3 days on real PRs). Set enforce=true by PR to block on failures; set it back to false as the owner's kill switch."

Suggestion: Choose one of two explicit paths and state it in the plan. Path A (for checks that run on every PR): add each new WS0 check as a step in PR-GATE.yml with continue-on-error: true and absent from OUTCOMES, following the Collab handoff pattern at PR-GATE.yml:65; a later governance PR adds it to OUTCOMES to make it enforcing. Path B (for path-triggered checks like SQL-MT-ISOLATION.yml): create each standalone workflow with an explicit REPORT_ONLY output that makes the job always exit 0 with a warning annotation until a governance PR removes the flag. Either way, ci-wiring must name the chosen path so the 'flip to enforcing' governance step has a concrete, mechanically verifiable target.

### R2-F3 [minor]

The revision resolves R1-F1 by adopting the VTID-05149 external-psql pattern and placing the runner in scripts/ci/sql-tests/run-mt-isolation-test.sh, but places the pgTAP spec files in supabase/tests/mt/**. In the VTID-05149 analogue the plan explicitly endorses, the .test.sql files live in scripts/ci/sql-tests/ alongside the runner (vtid-05149-tenant-foundation.test.sql), and SQL-TENANT-FOUNDATION.yml's paths: trigger watches scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql. The convention in supabase/tests/ is used exclusively by initdb/pg_ctl tests (vtid_05147_s_m_lockdown.test.sql is 'run by scripts/ci/test-vtid-05147-s-m-lockdown.sh'). The hybrid placement — scripts/ci/sql-tests/ runner + supabase/tests/mt/ SQL — matches neither pattern, and the new SQL-MT-ISOLATION.yml workflow's paths: trigger will need to watch supabase/tests/mt/** rather than scripts/ci/sql-tests/**, silently departing from the convention encoded in every other SQL-*.yml workflow.

- `exafyltd/vitana-platform:.github/workflows/SQL-TENANT-FOUNDATION.yml:17` —         - 'scripts/ci/sql-tests/run-tenant-foundation-test.sh'
        - 'scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql'
        - '.github/workflows/SQL-TENANT-FOUNDATION.yml'
- `exafyltd/vitana-platform:scripts/ci/sql-tests/run-tenant-foundation-test.sh:23` — FIXTURE="$ROOT/scripts/ci/sql-tests/vtid-05149-tenant-foundation.test.sql"
- `exafyltd/vitana-platform:supabase/tests/vtid_05147_s_m_lockdown.test.sql:1` — -- VTID-05147 (Track S / S-M) assertions, run by
-- scripts/ci/test-vtid-05147-s-m-lockdown.sh after the fixture and the
-- migration (applied twice). Every failure RAISEs; ON_ERROR_STOP ends the run.

Suggestion: Follow the VTID-05149 analogue consistently: place the pgTAP .test.sql files in scripts/ci/sql-tests/ (e.g. mt-isolation.test.sql) alongside run-mt-isolation-test.sh. This keeps the new SQL-MT-ISOLATION.yml paths: trigger consistent with every other SQL-*.yml workflow. If there is a strong reason to prefer supabase/tests/mt/ (e.g. IDE pgTAP integration), state it explicitly and acknowledge the departure from the VTID-05149 pattern.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Properly addressed. The revision removes the initdb/pg_ctl contradiction, adopts the external-psql pattern from scripts/ci/sql-tests/, depends on lane 1's running stack, and uses pg_prove. The residual SQL file placement inconsistency (supabase/tests/mt/ vs scripts/ci/sql-tests/) is raised as R2-F3.
- R1-F2: acknowledged — Properly addressed. pgTAP is reinstated as the parent plan requires, path (a) is taken (no parent amendment needed), and the plan correctly notes this is the first introduction of pgTAP into the repo. The unspecified installation mechanism is raised as R2-F1.
- R1-F3: acknowledged — Properly addressed. The plan now correctly narrows the claim to 'no DB-schema-reading inventory/lint generator' and directs lane-2 implementers to aurora-migration-inventory.cjs for output format conventions.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
