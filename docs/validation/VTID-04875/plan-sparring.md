# Plan sparring record — VTID-04875 (Command Hub Overview, Phase 1a)

This VTID is **Plan A, Phase 1a** of the Command Hub Overview supervisor cockpit. It was not sparred
separately: Phase 1a was itself created by the sparring of Plan A (finding **N1**, round 2 —
"Named in-process builders do not exist" → accepted → "new Phase 1a (own VTID, own PR)").

- **Sparring record:** [`docs/validation/VTID-04869/plan-sparring.md`](../VTID-04869/plan-sparring.md)
  (Plan A, all phases; full plan with every revision: `docs/validation/VTID-04869/plan-A-overview.md`,
  "REVISION 3 — N1" and "REVISION 2 — F3").
- **Plan:** A (Command Hub Overview) · **Phase:** 1a
- **Verdict:** CONVERGED (escalated after 3 rounds; the owner decided the open items on 2026-10-04).
- **Owner approval:** 2026-10-04, in session.

## Scope approved for Phase 1a (REVISION 3, N1)

Extract `buildPipelineSummary()` from `routes/autopilot.ts` (`GET /pipeline/summary`),
`buildVoiceOverview({ window, scope: { is_platform_admin: true } })` from
`routes/voice-supervisor.ts` (`GET /overview`) and `buildHealthSummary()` from
`routes/admin-health.ts` (`GET /health/summary`); the existing routes become thin wrappers with
byte-identical responses, snapshot tests, `npm run test:operator` (rule 42e) green. The health
builder keeps the deliberate loopback self-probe, documented as "as seen from the serving task".

Nothing outside that scope is in this change (no new routes, no `/ops/attention`, no frontend).
