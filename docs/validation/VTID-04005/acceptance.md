# VTID-04005 — Operator agent W0: CI job-log evidence, env ownership, on-ramp VTID self-allocation (flag-gated), allow_scope widening

Build plan: `docs/OPERATOR-AGENT-BUILD-PLAN.md`. Gap analysis: `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md`.

AC-1 — The CI watcher attaches bounded Actions job-log excerpts for the failing checks to the execution's failure reason and metadata (`ci_log_excerpts`), best-effort, so triage reasons from evidence instead of a check name.
TEST: services/gateway/test/dev-autopilot-ci-logs.test.ts
TEST: services/gateway/test/dev-autopilot-watcher.test.ts

AC-2 — `parseActionsJobId`, `extractLogExcerpt` (first-signal window + tail, budgeted) and `renderCiEvidence` are pure and deterministic; a failed log fetch marks the job `unavailable` instead of throwing.
TEST: services/gateway/test/dev-autopilot-ci-logs.test.ts

AC-3 — The executor stamps `metadata.claimed_env`/`claimed_at` on the row at claim time; the CI/deploy/verification watchers, the running-watchdog and the state reconciler skip executions stamped with another environment; unstamped (legacy) rows stay visible to every environment.
TEST: services/gateway/test/dev-autopilot-env-ownership.test.ts
TEST: services/gateway/test/dev-autopilot-execute.test.ts

AC-4 — `triggerOperatorExecution` accepts an omitted `vtid` ONLY when `OPERATOR_VTID_SELF_ALLOCATE_ENABLED=true`: it allocates through `allocate_global_vtid`, registers the row with a real title as `in_progress`/`approved`, then re-runs the existing governance gate; any allocation/registration failure refuses the execution. With the flag off (default) a missing vtid is rejected. The operator tool contract is unchanged (vtid still required).
TEST: services/gateway/test/vtid-04005-onramp-vtid-self-allocate.test.ts
TEST: services/gateway/test/vtid-03820-operator-execution-onramp.test.ts

AC-5 — `dev_autopilot_config.allow_scope` is widened additively (migration file + applied to the shared project) to `services/gateway/src/**`, `docs/**`, `scripts/**`, `config/**`, `DATABASE_SCHEMA.md` and sibling services; `deny_scope` unchanged; `CLAUDE.md` deliberately NOT added.
TEST: services/gateway/test/dev-autopilot-safety.test.ts
