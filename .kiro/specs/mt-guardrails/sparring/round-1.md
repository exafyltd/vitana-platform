# Sparring round 1 — in_progress

Session: `28937601-abfb-4e6d-b22d-0d6c76df7bcf` · plan hash `2e4927a92eb5d083877248d71ae6c649427a8fbf5aa0c9c461d07f6010a02df1`

## Summary

The plan is well-researched and its key factual premises about the existing codebase hold up against the code. The R1-F2 finding about the SUPABASE_URL binding mismatch in MORNING-SYSTEM-HEALTH-CHECK.yml is correctly identified and the fix is appropriately included. Two findings raised: the introduction of pgTAP as a second SQL test framework alongside the established raw-psql pattern needs justification, and the referenced npm test scripts should be verified as existing.

## Findings

### R1-F1 [major]

The plan proposes pgTAP + pg_prove for the isolation suite, but every existing SQL test in supabase/tests/ uses raw psql with \set ON_ERROR_STOP and custom assertion helpers (e.g. t05147.expect_error), run by shell scripts that spin up throwaway Postgres via initdb/pg_ctl. Introducing pgTAP creates two competing SQL test frameworks in the same directory without a stated migration plan or coexistence strategy. Implementors and reviewers will face ambiguity about which framework to use for future SQL tests.

- `exafyltd/vitana-platform:supabase/tests/vtid_05147_s_m_lockdown.test.sql:1` — -- VTID-05147 (Track S / S-M) assertions, run by
-- scripts/ci/test-vtid-05147-s-m-lockdown.sh after the fixture and the
-- migration (applied twice). Every failure RAISEs; ON_ERROR_STOP ends the run.
\set ON_ERROR_STOP 1
- `exafyltd/vitana-platform:scripts/ci/test-vtid-05147-s-m-lockdown.sh:34` — "${RUN_AS[@]}" "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"${RUN_AS[@]}" "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -w start >/dev/null

PSQL=("${RUN_AS[@]}" psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres -d postgres)
"${PSQL[@]}" -f "$FIXTURE"

Suggestion: Either (a) justify why pgTAP is needed over the established raw-psql + RAISE pattern (e.g. TAP output for CI harness integration, plan/subtest structure, richer assertion library) and state that new multi-tenant SQL tests use pgTAP while existing VTID tests remain as-is; or (b) use the existing raw-psql + RAISE pattern for the isolation suite to avoid the dual-framework tax. If pgTAP is chosen, add a brief note to the pgtap-isolation-suite lane about the coexistence policy and when/whether existing tests migrate.

### R1-F2 [minor]

The plan references npm scripts 'npm run test:support' (rule 42c), 'npm run test:operator' (rule 42e), 'npm run test:roles' (rule 42h) that must stay green after the maxina-golden-suite lane. These are stated as existing required test suites but their existence is not verified in the plan's premises. If any of these scripts do not exist in package.json, the lane's test section makes an unfulfillable promise. The PR-GATE config shows the test runner is plain jest, with no evidence these named scripts are wired.

- `exafyltd/vitana-platform:scripts/ci/pr-gate/config.json:1` — { "enforce": false, "note": "VTID-04950: PR-GATE starts report-only (plan rollout: 3 days on real PRs). Set enforce=true by PR to block on failures; set it back to false as the owner's kill switch.", "red_green": { "test_pattern": "^services/gateway/test/.*\\.test\\.ts$", "cwd": "services/gateway", "cmd": ["npx", "jest"] } }

Suggestion: Verify that test:support, test:operator, and test:roles scripts exist in the relevant package.json and document the verification in the premises section, or qualify the claim as 'if these scripts exist'.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
