# Plan sparring record — VTID-04886 (Command Hub Overview, Phase 3)

This VTID is **Plan A, Phase 3** of the Command Hub Overview supervisor cockpit. It was not sparred
separately: Phase 3 is a phase of Plan A, which was sparred as a whole before any of its VTIDs
were allocated.

- **Sparring record:** [`docs/validation/VTID-04869/plan-sparring.md`](../VTID-04869/plan-sparring.md)
  (Plan A, all phases; full plan with every revision: `docs/validation/VTID-04869/plan-A-overview.md`).
- **Plan:** A (Command Hub Overview) · **Phase:** 3
- **Verdict:** CONVERGED (escalated after 3 rounds; the owner decided the open items on 2026-10-04).
- **Owner approval:** 2026-10-04, in session.

## Scope approved for Phase 3

From the plan's REVISION 2 (F5, F9, F13) and the revised phase list:

- Ack/Snooze keyed by fingerprint (source + entity id, env-scoped): table `ops_attention_acks` (who,
  when, reason, expiry, optional VTID) via the gateway, migration + DATABASE_SCHEMA.md, RLS
  platform-admin (service role) only (F5).
- P1 ackable, never snoozable; ack/snooze needs a reason and an expiry ≤ 24 h; OASIS
  `ops.attention.acked` / `ops.attention.snoozed` (F5).
- The 24 h change & incident timeline and key SLI sparklines (F9, Phase 3).
- Opt-in browser notification only when a NEW fingerprint reaches P1 (F13).

Out of scope here and tracked in Phase 4 (VTID-04887): redirects of the four old Overview tabs, the
other `/pipeline/summary` consumers (Q6) and dead-code removal.
