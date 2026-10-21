# VTID-05012 — Jev self-healing observability (skip rows, abstain scoring, silent-gate health)

Slice 1 of the Jev self-heal / self-improve roadmap. Plan sparred (2 rounds, converged) and owner-approved
2026-10-09 — `plan-sparring.md`, plan hash `d6ebcae570cac5c10118b59642a2ccac5f777846ace868cb7feafc1b04f81635`.

VALIDATION_PROFILE: gateway_backend

## Why

Read-only, 30 days to 2026-10-09: none of the Dev Autopilot Jev gates had a row (they shipped 2026-10-01;
`dev_autopilot_config.kill_switch` has been armed since 2026-10-07); several gates ended without a row when
they had nothing to ask; abstained rows were never compared with the outcome (plannability 125,
voice_session_outcome 150, 0 compared).

## Acceptance criteria

AC-1: `jev_shadow_decisions.jev_outcome` allows `'skipped'`; `skip_reason` is set exactly when the outcome is
`skipped`; one skipped row per (gate, subject_ref, skip_reason) (partial unique index `uq_jev_shadow_skip`);
`lean_agreed` added. Existing outcome values and rows are unaffected. Migration is idempotent and the rollback
restores the VTID-04754 shape.
  TEST: scripts/ci/test-vtid-05012-jev-gate-observability.sh (local Postgres), services/gateway/test/vtid-05012-jev-gate-observability.test.ts
AC-2: `recordJevGateSkip` writes a $0 row carrying the gate's own mode (`shadow`/`enforce`), the reason and the
subject; a duplicate (23505) or any error returns null and never throws; no row without a client or subject.
  TEST: services/gateway/test/vtid-05012-jev-gate-observability.test.ts
AC-3: Gates that are on and end without asking Jev write a skipped row: ci-failure (`no_ci_evidence`), pr-clash
(`no_merging_files`, `no_overlapping_changes`), fix-verification (`no_fix_context`), repeat-run (`no_plan`,
`no_previous_run`), approval-risk (`payroll_excluded`; the not-queued filter stays silent), claim-feasibility
(`no_plan_or_finding`), and `error` in the catch of those plus change-risk and test-selection. Mode `off` writes
nothing; the decided path writes no skipped row; return values are unchanged (null).
  TEST: services/gateway/test/vtid-05012-jev-gate-observability.test.ts and the updated gate suites
  (vtid-04774, -04801, -04808, -04811 — their "no row" assertions now expect the skipped row; intentional
  contract change)
AC-4: plannability and voice_session_outcome keep the below-threshold answer of an abstained call
(`jev_verdict.lean`) and set `lean_agreed`; `agreed` stays decided-only, so existing agreement rates are
unchanged. plannability sets it in the existing outcome update; voice_session_outcome at insert.
  TEST: services/gateway/test/vtid-05012-jev-gate-observability.test.ts, test/vtid-04806-plannability.test.ts,
  test/vtid-04775-voice-outcome-gate.test.ts
AC-5: `jev_shadow_gate_stats(days)` returns `skipped`, `last_row_at`, `lean_compared`, `lean_agreed`; `calls`
excludes skipped rows; grants unchanged (service_role only).
  TEST: scripts/ci/test-vtid-05012-jev-gate-observability.sh
AC-6: `GET /api/v1/jev/admin/stats` (still requireAuth + requireExafyAdmin) adds `gate_health` — every gate whose
`JEV_*_MODE` is shadow/enforce, with `last_row_at` and `silent` after 48 h without any row — and
`loops.dev_autopilot` `{kill_switch, updated_at}`.
  TEST: services/gateway/test/vtid-05012-jev-gate-observability.test.ts, test/routes/jev-decisions.test.ts
AC-7: Regression suites green: `npm run test:operator`, `npm run test:roles`, `npm run test:support`.
  TEST: outputs/regression-suites.txt

## Deployment order

The migration is applied (RUN-MIGRATION.yml) and verified read-only BEFORE merge: the new gateway code writes
`skip_reason`/`lean_agreed`, which PostgREST would reject on the old schema (voice_session_outcome rows would be
lost). The change is additive; production code that has not received this change keeps working against the new
schema (it never writes the new columns, and reads the RPC fields by name).

## Out of scope

Re-arming the Dev Autopilot kill switch; any gate to enforce; the CI-triage provider-outage storm
(2026-09-22/23); outcome joining, new decisions and a promotion policy (later slices, each its own plan).

OASIS_IMPACT: no
