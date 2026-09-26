# VTID-04666 — results summary

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| New suites (`test/vtid-04666-*`, 5 files) | 51 / 51 pass |
| Neighbouring suites (synthesis, dev-autopilot route, recommendations route, watcher noise VTID-04377/04625, voice next-actions, lineup) | pass (one incidental assertion updated in `dev-autopilot-synthesis.test.ts`) |
| Full gateway jest | 1344 suites passed, 1 skipped; 21,605 tests passed, 29 skipped, 6 todo, 0 failed |
| Mutation: noise skip removed | 2 of 11 oasis tests fail |
| Mutation: risk rank removed | 1 of 10 dev-findings tests fail |
| Mutation: is_terminal check removed | 2 of 16 roadmap tests fail |
| Migration / data fix parse (pglast) | 8 + 3 statements; 4 PL/pgSQL bodies parse |

Pending (human-dispatched, `RUN-MIGRATION.yml`):
1. `supabase/migrations/20260926140000_vtid_04666_recommendation_noise.sql`
2. `supabase/migrations/data-fixups/20260926140100_vtid_04666_reject_noise.sql` (after the gateway code is live)
