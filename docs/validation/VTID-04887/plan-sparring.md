# Plan sparring record — VTID-04887 (Command Hub Overview, Phase 4)

This VTID is **Plan A, Phase 4** of the Command Hub Overview supervisor cockpit. It was not sparred
separately: Phase 4 is a phase of Plan A, which was sparred as a whole before any of its VTIDs
were allocated.

- **Sparring record:** [`docs/validation/VTID-04869/plan-sparring.md`](../VTID-04869/plan-sparring.md)
  (Plan A, all phases; full plan with every revision: `docs/validation/VTID-04869/plan-A-overview.md`).
- **Plan:** A (Command Hub Overview) · **Phase:** 4
- **Verdict:** CONVERGED (escalated after 3 rounds; the owner decided the open items on 2026-10-04).
- **Owner approval:** 2026-10-04, in session.

## Scope approved for Phase 4

From the plan's design section, REVISION 2 (answer Q6) and the revised phase list:

- The Overview's other four tabs (live-metrics, recent-events, errors-violations, release-feed)
  become redirects to their specialised screens.
- The other `/autopilot/pipeline/summary` consumers (Operator dashboard, runbook) switch to an
  admin-gated in-process route (Q6).
- Dead functions and hardcoded lists are deleted.

Implementation notes that stay inside that scope:
- The collapsed pre-Phase-1 panels are deleted where the Phase 2 tiles, the queue and the Phase 3
  timeline cover them. Vitana Recommends is not covered and is kept (`acceptance.md` AC-5).
- The voice navigation catalog retires the four tab screens into `formerIds`, so legacy ids keep
  working.
