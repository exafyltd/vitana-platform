---
lane: matching-discover-scope-v1
state: ready
next_actor: owner
depends_on: [matching-intent-scope-db]
executor: kiro
seat: exafyltd
reviewer_seat: jtadic
area: frontend
paths:
  - supabase/functions/generate-daily-matches/index.ts
  - src/components/match/**
  - src/pages/FindAMatch.tsx
  - src/hooks/useRealMatches.ts
  - src/i18n/de/match.json
  - src/i18n/en/match.json
  - src/hooks/useRealMatches.scope.test.ts
  - tests/e2e/staging/mt-network-find-a-match.staging.spec.ts
updated: 2026-10-15T16:40Z
---
# mt-network/matching-discover-scope-v1 — Find-a-Match/Discover scope wiring (repo vitana-v1)

Plan: `.kiro/specs/mt-network/plan.md`; tasks: the `matching-discover-scope-v1` group in `tasks.md`; design: `design.md`. **Held:** `next_actor: owner` until PLAN-SPAR allocates the VTID. `area: frontend` (seat `exafyltd`) — the catch-all; no messenger path here.

Code lane, dark behind `mt.network_enabled`. Scopes the `generate-daily-matches` candidate pool by `daily_matches.scope` (network pool = `network_visible` only; no Vitana Index inputs, D25) and wires the Find-a-Match scope control (reuse the messenger/matching scope; separate from Discover's existing tab pill). Spotlight on touched screens; i18n DE-first du-form; RTL. Read-only staging spec. Own `docs/validation/<vtid>/`.

§7a rules apply (no live writes; the edge function change ships as code, applied/deployed by Claude, never by Kiro). Depends on `matching-intent-scope-db` (the `daily_matches.scope` column + scoped matchers). Work only inside the allowed paths.

Branch `kiro/mt-network/matching-discover-scope-v1`; PR title `VTID-xxxxx (mt-network/matching-discover-scope-v1): …`; trailers `Collab-Session`, `Collab-Lane: mt-network/matching-discover-scope-v1`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the planner. Held until the VTID is allocated.
