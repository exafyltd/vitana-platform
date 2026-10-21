# VTID-05012 — plan sparring record

Plan hash (sha256 of the normalised text between the plan markers): `d6ebcae570cac5c10118b59642a2ccac5f777846ace868cb7feafc1b04f81635`
Partner: plan-sparring-partner (independent, read-only). Rounds: 2. Verdict: **CONVERGED**.

**Owner approval:** "Yes" in the Claude Code session, 2026-10-09 (Gate 1, Autonomy Contract VTID-04947), for this plan hash.

Partner findings are kept verbatim in the session transcript; the summary and the planner's answers follow the plan.

# Plan: Jev self-healing observability (slice 1 of the Jev self-heal / self-improve roadmap)

Planner: Claude Code session (claude/funny-mccarthy-1bt8nz), 2026-10-09. Repo: exafyltd/vitana-platform.

<!-- plan:begin -->
## Change class

standard (one migration, one existing admin route extended, ~8 gate modules, tests, docs).

## Why (evidence, read-only queries on the shared Supabase project, 30 days to 2026-10-09)

1. Jev gates on the Dev Autopilot loop have zero rows: ci_failure, change_risk, pr_clash,
   test_selection, fix_verification, repeat_run, approval_risk, agent_progress. They shipped
   2026-10-01 (VTID-04800/04803/04807/04808/04815) and are pinned `shadow` in both
   AWS-STAGE-DEPLOY-GATEWAY.yml and AWS-PROD-DEPLOY-GATEWAY.yml. `jev.decision.*` OASIS events
   show no `decide()` call from any of them, so they never reached Jev.
2. The loop they sit on is stopped: `dev_autopilot_config.kill_switch = true` (updated
   2026-10-07); the only CI escalation since 2026-10-01 is "Escalated: kill switch armed".
   Nothing in the Jev stats tells a reader that, so "silent gate" and "idle loop" look the same.
3. Several gates return early after the mode check with no row (e.g.
   `runCiFailureRouting`, ci-failure-gate.ts: `if (usable.length === 0) return null;`), so even
   with the loop running a skip is invisible.
4. Abstained rows never get an outcome. plannability: 125 abstained (confidence 0.5–0.7),
   0 compared; voice_session_outcome: 150 abstained, 0 compared. The outcome writers compute
   `agreed` only from a decided verdict (plannability-gate.ts:94/142, voice-outcome-gate.ts:138–140),
   so we cannot tell whether the thresholds are too strict.
5. 2026-09-22/23: 490 CI escalations, each "Triage failed: both providers failed:
   primary=Bedrock invoke_failed: Operation not allowed; fallback=DeepSeek 402". One row per
   execution, so not VTID churn but a provider-outage storm the loop kept feeding.

## Scope (this VTID only)

A. **Skip rows.** Migration adds `'skipped'` to the `jev_shadow_decisions.jev_outcome` CHECK
   constraint and two nullable columns: `skip_reason text` and `lean_agreed boolean`. New helper
   `recordJevGateSkip({gate, decision, mode, reason, subject_type, subject_ref})` in
   `jev-shadow.ts` writes a $0 row (`jev_outcome='skipped'`, `skip_reason=reason`,
   `mode` = the gate's current mode, `shadow` or `enforce`, never a new value; `cost_usd=0`).
   Duplicates are suppressed by a partial unique index
   `(gate, subject_ref, skip_reason) WHERE jev_outcome='skipped'` (a real column, not a JSONB
   expression); the helper inserts with `on conflict do nothing` and requires a non-null
   `subject_ref`. Mode `off` still writes nothing.
   Wired, for the internal-plane Dev Autopilot / self-heal gates whose run function can end
   without a row after the mode check (verified per file):
   - data-absent returns: ci-failure (`usable.length === 0`, :74), pr-clash (no merging files
     :88, no overlapping pairs :90), fix-verification (no fix context :72), repeat-run (no
     previous run or plan :72), approval-risk (no input :89; the `status !== 'awaiting_approval'`
     filter on :86 stays silent, it is normal filtering, not a skip), claim-feasibility (:69);
   - the `catch` returns of all of the above plus change-risk (:104) and test-selection (:174),
     reason `error` (today only a console line).
   Not wired: agent-progress (no early-return path; its zero rows are explained by the armed kill
   switch, see evidence 2), and the community / voice gates (sampling skips are by design).
   Evidence point 1 is read accordingly: agent_progress is listed there because it has zero rows,
   but only the gates above have a silent path to fix.

B. **Lean outcome for abstained rows.** The below-threshold verdict is already returned on
   abstain (`ok: true` with `verdict`, jev-decision-service.ts:215/230–242). It is stored as
   `jev_verdict.lean`, and `lean_agreed` is set for abstained rows; `agreed` keeps its meaning
   (decided rows only), so existing agreement numbers do not change. Timing differs per gate:
   - plannability: `agreed` is written later by the outcome pass (`recordJevShadowOutcome`,
     plannability-gate.ts:142–143); `lean_agreed` is set in that same update (the update payload
     gains one field; `recordJevShadowOutcome` takes an optional `leanAgreed`).
   - voice_session_outcome: `agreed` is computed at insert (voice-outcome-gate.ts:138–164);
     `lean_agreed` is computed at insert too, from the lean value vs the same expected class.

C. **Gate health in the existing admin endpoint.** `jev_shadow_gate_stats(p_days)` is replaced
   (same name, same grants) to also return per gate: `skipped`, `last_row_at`,
   `lean_compared`, `lean_agreed`. `GET /api/v1/jev/admin/stats` (routes/jev-decisions.ts,
   already `requireAuth + requireExafyAdmin`) adds:
   - `gate_health[]`: for each `JEV_*_MODE` env var not `off`, the gate's last row time and
     `silent: true` when no row (any outcome, skipped included) in 48 h;
   - `loops.dev_autopilot`: `{kill_switch, updated_at}` read from `dev_autopilot_config` id=1,
     so a silent Dev Autopilot gate is shown next to the reason.
   Read-only; no new route, no new scheduler, no new alert channel.

D. **Docs.** DATABASE_SCHEMA.md (new outcome value, column, index, RPC fields);
   docs/JEV-INTEGRATION-PLAN.md (observability section + the roadmap below);
   docs/validation/<VTID>/ (acceptance, commands.log, outputs, staging-tests.json,
   plan-sparring.md).

## Out of scope (explicitly)

- Re-arming the Dev Autopilot kill switch (owner decision; not touched, not proposed here).
- Any gate moving to `enforce`.
- The provider-outage storm fix (triage fallback to an unfunded DeepSeek account, no breaker on
  "both providers failed"). Reported to the owner as a separate finding for its own plan.
- Slices 2–4 below; each gets its own plan, sparring and Gate 1 once slice 1 has data.

## Tests

- New `test/vtid-<n>-jev-gate-observability.test.ts`:
  - each wired return writes exactly one `skipped` row with the right `skip_reason`, the
    gate's mode and subject_ref (positive path, primary assertion); a second identical skip
    writes no second row; none in mode `off`; none on the normal decided path;
  - `recordJevGateSkip` returns null without throwing when there is no client or the insert
    fails (inherited pattern, secondary);
  - plannability / voice_session_outcome: abstained row gets `lean_agreed`, `agreed` stays null;
    decided rows unchanged;
  - admin stats: `silent` true/false at the 48 h boundary, `loops.dev_autopilot` present,
    endpoint still 403 for non-admins.
- SQL test (supabase/tests) for the CHECK, the partial unique index and the RPC shape.
- Keep green: `npm run test:operator`, `npm run test:roles`, `npm run test:support`, the existing
  per-gate suites.
- Staging (read-only): `staging-tests.json` probes `GET /api/v1/jev/admin/stats` unauthenticated
  → 401/403 JSON (route exists, not HTML), plus the existing jest suite refs.
- Migration applied through `RUN-MIGRATION.yml`; verified read-only (constraint text, index,
  RPC returns the new fields).

## Files in scope

- supabase/migrations/<ts>_vtid_<n>_jev_gate_observability.sql (+ rollback in docs/validation)
- services/gateway/src/services/jev/jev-shadow.ts, jev-repository.ts
- services/gateway/src/services/jev/gates/{ci-failure,change-risk,pr-clash,test-selection,
  fix-verification,repeat-run,approval-risk,claim-feasibility,plannability,voice-outcome}-gate.ts
- services/gateway/src/routes/jev-decisions.ts
- services/gateway/test/vtid-<n>-jev-gate-observability.test.ts, supabase/tests/vtid_<n>_*.sql
- DATABASE_SCHEMA.md, docs/JEV-INTEGRATION-PLAN.md, docs/validation/<VTID>/*

## Roadmap after this slice (informational, not approved by this plan)

2. Outcome joining: tie each Dev Autopilot gate row to the real result (PR merged and kept,
   closed after CI, reverted after deploy, incident recurred) and compute weekly precision.
3. New shadow decisions where the loop fails: "will this diff fail CI / be reverted" (extends
   change_risk), escalation triage (fixable / human / duplicate / infra), failed-fix
   classification so retries change strategy.
4. Promotion policy: ≥200 decided rows, ≥90 % precision against real outcomes, owner yes per
   gate; plannability is the first candidate once its abstain rate is understood.
<!-- plan:end -->

## Planner responses — round 1

- **F1 [major] ACCEPTED.** Evidence and scope reconciled. Scope A is now defined by code, not by
  the zero-row list: every Dev Autopilot / self-heal gate whose run function can end without a
  row after the mode check, with file:line per path. claim-feasibility is in (silent return at
  :69 even though it has 2 rows); agent-progress is out (no early-return path, zero rows explained
  by the kill switch). change-risk and test-selection join for their `catch` returns only.
- **F2 [major] ACCEPTED.** `skip_reason` is a real text column; the partial unique index is
  `(gate, subject_ref, skip_reason) WHERE jev_outcome='skipped'`; helper requires subject_ref.
- **F3 [minor] ACCEPTED.** Verified: agent-progress has no early return; not wired.
- **F4 [minor] ACCEPTED.** Skip rows carry the gate's current mode (`shadow`/`enforce`), no new
  mode value; stated in scope A.
- **F5 [minor] ACCEPTED.** Positive-path row assertions are now the primary test; the
  no-throw case is secondary.
- **F6 [minor] Acknowledged**, no change (auth is inherited).
- **Q3** answered in scope B: plannability sets `lean_agreed` in the existing outcome update;
  voice_session_outcome sets it at insert.

## Partner — round 2

F1 closed, F2 closed, F3 closed, F4 closed, F5 closed, F6 acknowledged. All new file:line claims
verified (pr-clash :88/:90, approval-risk :86/:89, change-risk :102–104, test-selection :172–174,
claim-feasibility :67–69, fix-verification :71–72, repeat-run :71–72). No new blocker or major.

## Verdict

CONVERGED (2 rounds, change class standard).
