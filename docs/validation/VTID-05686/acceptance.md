# VTID-05686 acceptance (strategy-execution-wave1/autonomy-risks, tasks.md T1-T2)

Change types: Tooling/docs. Docs-only lane: no behaviour changes, so no behaviour test (`scope.json`
`red_green_exempt`). Each AC maps to a check whose run and output are in `commands.log`.

AC-1 Only the lane paths change: `docs/programs/strategy-execution/autonomy-risk-register.md` and
`docs/validation/VTID-05686/**`. No code, schema, flag, workflow, `CLAUDE.md`, `areas.yaml` or multi-tenant spec change.
TEST: git status --porcelain --untracked-files=all (commands.log step 2, every path inside the lane globs)

AC-2 Every `file:line` citation in the register resolves at `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`: the file exists
and has at least the highest cited line.
TEST: node docs/validation/VTID-05686/citation-check.mjs . docs/programs/strategy-execution/autonomy-risk-register.md (0 failures)

AC-3 The key cited lines contain the code the register describes (re-read at HEAD, not copied from the strategy
register). The citation checker itself fails on a bad citation.
TEST: anchor check and checker mutation in commands.log steps 4-5 (all anchors ok; mutated copy exits 1)

AC-4 One register row per risk (a) to (k), with an explicit entry for the `self-healing.rollback.completed` event-type
gap (`self-healing-snapshot-service.ts:460-472`, plan §4.3) separate from the missing rollback mechanism. Every row has
severity with reason, current status (one status class), tenant-isolation, security, execution-integrity and
financial/publishing impact, owner role, dependencies, proposed remediation and verification evidence.
TEST: row and column check in commands.log step 6 (13 rows, 11 cells each, AR-04 present)

AC-5 Flag defaults are stated with verified lines: `AUTOPILOT_LOOP_ENABLED` off (`index.ts:1808`),
`DEV_AUTOPILOT_EXECUTOR_ENABLED` and `DEV_AUTOPILOT_WATCHERS_ENABLED` on (`index.ts:2279,2293`), `ROUTINE_RUNNER_ENABLED`
off (comment `index.ts:2135`, check `routine-runner/runner.ts:66`).
TEST: anchor check in commands.log step 4

AC-6 Worker-runner and Dispatcher facts are stated as found: no `services/worker-runner/`, no
`AWS-PROD-DEPLOY-WORKER-RUNNER.yml`, no `EXEC-DEPLOY.yml`, `.claude/rules/infrastructure.md:59` still names them; no
Dispatcher service, only in-process dispatchers.
TEST: absence listing in commands.log step 3

AC-7 The register orders the critical risks to fix before any broader autonomy activation and recommends no autonomy
setting change for activation; every remediation is a proposed follow-up.
TEST: wording check in commands.log step 7 (no line recommends enabling, arming or raising a level)

AC-8 Evidence files are valid: `scope.json` passes the PR-GATE `validateScope`, this file passes the Acceptance
Mapping Gate, and the collab tests pass.
TEST: node --test scripts/collab/*.test.mjs; validateScope and checkAcceptanceMapping in commands.log step 8
