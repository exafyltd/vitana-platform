# Plan sparring record — VTID-04876 (Command Hub Overview, Phase 1)

This VTID is **Plan A, Phase 1** of the Command Hub Overview supervisor cockpit. It was not sparred
separately: Phase 1 is a phase of Plan A, which was sparred as a whole before any of its VTIDs
were allocated.

- **Sparring record:** [`docs/validation/VTID-04869/plan-sparring.md`](../VTID-04869/plan-sparring.md)
  (Plan A, all phases; full plan with every revision: `docs/validation/VTID-04869/plan-A-overview.md`).
- **Plan:** A (Command Hub Overview) · **Phase:** 1
- **Verdict:** CONVERGED (escalated after 3 rounds; the owner decided the open items on 2026-10-04).
- **Owner approval:** 2026-10-04, in session.

## Scope approved for Phase 1

From the plan's REVISION 2 (F1–F14), REVISION 3 (N2–N7), REVISION 4 (N8) and owner decisions 6–8:

- `GET /api/v1/ops/attention` (`requireAdminAuth`, platform exafy_admin only) with seven in-process
  adapters (service health, release, voice supervisor, autonomy, operator pipeline, governance,
  decisions waiting) and the numeric rubric amended by N4/N5/N7; 3 s per-adapter timeout → UNKNOWN;
  single-flight + 20–30 s cache; verdict UNKNOWN whenever a source is unknown and there is no P1.
- Time-based hysteresis from source timestamps, else `ops_attention_state` (env, fingerprint,
  first_seen, last_seen; PK (env, fingerprint)); staging may write `env='staging'` rows (owner
  decision 6); a state failure never breaks the response.
- `golden_path: true` on the Gateway, Auth, ORB/Nova, Supabase/Aurora data and prod-frontend
  registry entries (N5).
- `/api/v1/ops/action-required` gated behind `requireAdminAuth` (F4); its Command Hub consumer
  migrated to `/ops/attention`.
- Overview rewritten into a status bar + ranked "Needs attention now" queue (F9, F11, F12), 30 s
  poll on the real router keys, "Cockpit blind — check GChat" after 2× the poll interval or on a
  fetch error (F1); the `?vtid=` / `?session=` deep-link contract with toast + list fallback (F10).

Out of scope here and tracked in later phases of the same plan: domain tiles and more adapters
(Phase 2), Ack/Snooze + timeline + sparklines + notifications (Phase 3), redirects of the old
Overview tabs and dead-code removal (Phase 4). The ALB target-health alarm is its own infra VTID
(owner decision 8).
