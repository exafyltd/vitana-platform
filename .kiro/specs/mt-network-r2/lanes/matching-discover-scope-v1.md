---
lane: matching-discover-scope-v1
state: ready
next_actor: kiro
depends_on: [matching-intent-scope-db]
executor: kiro
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
area: frontend
paths:
  - supabase/functions/generate-daily-matches/index.ts
  - src/hooks/useRealMatches.ts
  - src/hooks/useRealMatches.scope.test.ts
  - src/components/intents/FindMatchFilterSheet.tsx
  - src/i18n/de/screens.json
  - src/i18n/en/screens.json
  - tests/e2e/staging/mt-network-matching.staging.spec.ts
updated: 2026-11-01T15:54Z
repos: [exafyltd/vitana-v1]
---
# mt-network-r2/matching-discover-scope-v1 — Find-a-Match/Discover scope wiring (repo vitana-v1)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `matching-discover-scope-v1` group in `tasks.md`; design: `design.md`. 
Code lane, dark behind `mt.network_enabled`. Scopes the `generate-daily-matches` candidate pool by `daily_matches.scope` (network pool = `network_visible` only; no Vitana Index inputs, D25) and wires the Find-a-Match scope control (reuse the messenger/matching scope; separate from Discover's existing tab pill). Spotlight on touched screens; i18n DE-first du-form; RTL. Read-only staging spec. Own `docs/validation/<vtid>/`.

§7a rules apply (no live writes; the edge function change ships as code, applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d); deployed by the normal workflow). Depends on `matching-intent-scope-db` (the `daily_matches.scope` column + scoped matchers). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/matching-discover-scope-v1`; PR title `VTID-xxxxx (mt-network-r2/matching-discover-scope-v1): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/matching-discover-scope-v1`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/matching-discover-scope-v1`. Paths corrected to the real files on `main`. Versions day-shifted to `20261102050*`. Reviewer agent.
