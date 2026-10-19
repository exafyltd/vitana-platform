# VTID-05214 — PM Agent P1: CI sparring (PLAN-SPAR.yml) + policy approval of converged plans

Plan: `.kiro/specs/pm-agent/plan-sparring.md` (v2 §3–§4, CONVERGED, owner Gate 1 "yes" 2026-10-15).

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: A sparring session created with `approval_policy: converged-auto-v1` is approved by policy when it converges; an escalated session never is; a session without the policy waits for the owner; new rounds and the owner approval are refused once policy-approved; an unknown policy is a 400.
  TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts (describe "VTID-05214 policy approval")
AC-2: The DB gate accepts a policy approval of a converged session in log and enforce mode, refuses an unapproved or in-progress one; a CHECK makes a policy approval impossible on a non-converged session or one that did not ask for it; round appends freeze on either approval; pm_lease admits one holder; pm_digests is append-only; rollback restores the owner-only gate.
  TEST: services/gateway/test/vtid-05214-policy-approval-migration.test.ts (runs scripts/ci/test-vtid-05214-policy-approval.sh on a throwaway Postgres)
AC-3: The reconciler reports `policy_approval_on_non_converged`.
  TEST: services/gateway/test/vtid-04868-plan-sparring-service.test.ts
AC-4: plan-spar.mjs: round files and state are written; responses submitted once; converged + policy approval → handoff sparred/next claude, or with allocation one VTID per lane (first bound to the sparring record) and handoff approved/next kiro; one re-plan session, a second escalation parks; a partner outage goes to Claude, never parked, and the retry does not use up a session; a lost long call is recovered by polling.
  TEST: scripts/collab/plan-spar.test.mjs
AC-5: The collab validator accepts a ci-plan-spar commit taking a plan drafted → approved and writing VTIDs into ready lanes, and refuses the same change from any other session.
  TEST: scripts/collab/queue.test.mjs
AC-6: PLAN-SPAR.yml runs only on same-repository `plan(` PRs, from the base branch's code, with PLAN_SPAR_ENABLED=true; it skips its own commits.
  TEST: .github/workflows/PLAN-SPAR.yml (review: pull_request_target + base checkout + head-as-data; `if:` same-repo + title + variable; guard step)

## OASIS

OASIS_PROOF: services/gateway/test/vtid-04868-plan-sparring-service.test.ts — "VTID-05214 policy approval › reconciler reports a policy approval on a non-converged session" asserts the emitted event `vtid.plan_sparring.tamper_detected` with `payload.check = policy_approval_on_non_converged`. No other new OASIS event; sparring rounds stay out of OASIS (VTID-04868 F3).
