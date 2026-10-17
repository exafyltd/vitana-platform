---
lane: persona-pack
state: ready
next_actor: owner
depends_on: []
executor: kiro
seat: jtadic
reviewer_seat: exafy
paths:
  - services/gateway/src/services/ai-personality-service.ts
  - services/gateway/src/orb/profile/**
  - services/gateway/src/orb/live/instruction/**
  - services/gateway/src/orb/instruction/greeting-pools.ts
  - services/gateway/test/mt-packs-persona-*.test.ts
updated: 2026-10-15T19:05Z
---
# persona-pack — persona split + runtime getEffectiveConfig (repo vitana-platform)

Plan: `.kiro/specs/mt-packs/plan.md` (authoritative) and the `persona-pack` section of `tasks.md` (P1–P4,
allowed paths, acceptance). Design + successor rules: `design.md`.

Split `voice_live.base_identity` (`ai-personality-service.ts:86`) into a FIXED Vitana identity block and a
TENANT block assembled from pack FACTS + English INTENTS; resolve the tenant block via
`getEffectiveConfig(surfaceKey, ctx.tenantId)` (`:659`) in the live instruction builders. Rule 41 is absolute:
no templated spoken sentence, no `{{brand}}` in spoken strings. Maxina output byte-identical with no override
(golden equality). Dark by default (`MT_RESOLUTION_V2`, `tenant_settings.feature_flags.mt.packs`). `orb-live.ts`
is out of scope beyond ≤20-line hot-file touches (program §8). This lane adds its own
`docs/validation/<vtid>/` (plan-sparring.md copy, scope.json, staging-tests.json).

**HELD:** `next_actor: owner` until PLAN-SPAR allocates this lane's VTID; PLAN-SPAR flips it to `kiro`. The
seat automations build only lanes marked `next_actor: kiro`.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed paths. Branch
`kiro/mt-packs/persona-pack`; PR title `VTID-xxxxx (mt-packs/persona-pack): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-packs/persona-pack`. When the PR is open: set
`state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:18Z · kiro-hotmail-202610151618-b437 · created → ready
Created by the mt-packs planner. Seat `jtadic` (uncovered platform gateway work → jtadic per the brief's lane
assignment), reviewer `exafy` (≠ seat). Held at `owner` pending VTID allocation by PLAN-SPAR.

### 2026-10-15T19:05Z · kiro-hotmail-202610151618-b437 · internal-review fix (round 2)
MEDIUM-1: removed the false `area: backoffice` label. Verified against `docs/programs/areas.yaml`: `backoffice`
covers only `routes/backoffice-*.ts` and `services/backoffice*/**`; this lane's paths
(`ai-personality-service.ts`, `orb/profile/**`, `orb/live/instruction/**`, `orb/instruction/greeting-pools.ts`)
match no area, and no general `gateway` area exists. `area` dropped (optional); `seat: jtadic` kept. No path or
scope change.
