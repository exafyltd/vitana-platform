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
  - services/gateway/src/routes/orb-live.ts
  - services/gateway/src/orb/live/session/live-session-controller.ts
  - services/gateway/src/orb/live/types.ts
  - services/gateway/src/services/tenancy/tenant-context.ts
  - services/gateway/src/services/conversation/compute-greeting-decision.ts
  - services/gateway/test/orb/live/characterization/no-hardcoded-spoken-wording.test.ts
  - services/gateway/test/orb/instruction/first-time-welcome.test.ts
  - services/gateway/test/mt-packs-persona-*.test.ts
updated: 2026-10-20T16:55Z
---
# persona-pack — persona split + runtime getEffectiveConfig (repo vitana-platform)

Plan: `.kiro/specs/mt-packs/plan.md` (authoritative) and the `persona-pack` section of `tasks.md` (P1–P4,
allowed paths, acceptance). Design + successor rules: `design.md`.

Split `voice_live.base_identity` (`ai-personality-service.ts:86`) into a FIXED Vitana identity block and a
TENANT block assembled from pack FACTS + English INTENTS; resolve the tenant block via
the new sync `getEffectiveConfigSync(surfaceKey, tenantId)` over a per-tenant cache filled at session start by `prewarmEffectiveConfig` (which awaits `getEffectiveConfig`, `:658`); today's `getPersonalityConfigSync` (`:460`) is surface-keyed only. Rule 41 is absolute:
no templated spoken sentence, no `{{brand}}` in spoken strings. Maxina output byte-identical with no override
(golden equality). Dark by default (`MT_RESOLUTION_V2`, `tenant_settings.feature_flags.mt.packs`).
`buildLiveSystemInstruction` stays SYNC — the tenant config is pre-fetched at session start and passed in as a
parameter; `buildAnonymousSystemInstruction` is extracted verbatim into
`orb/live/instruction/anonymous-system-instruction.ts` (snapshot-gated) and takes a server-validated `tenantId` (anonymous `tenant_slug` on `POST /live/session/start` → `getTenantIdBySlug` → `session.anonTenantId`). The dead `buildFirstTimeWelcomeLine` is deleted; the live welcome intent (`compute-greeting-decision.ts:1233`) takes the community name from a new optional `GreetingDecisionContext.communityName` (default `'Maxina'`, set from `session.packFacts` at the three context literals `orb-live.ts:10917/11297/11584`); the rule-41 guard is extended to `greeting-pools.ts`.
`orb-live.ts` is touched ONLY for the verbatim move, +1 import, +1 argument at `:7652`, +1 argument at `:7678`, −1 import identifier at `:413`, +1 `communityName` field line at `:10917`/`:11297`/`:11584` (program §8
hot-file cap; no logic rewritten there). This lane adds its own
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

### 2026-10-17T16:45Z · kiro-hotmail-202610151618-b437 · spar round 1 (session 1896989e) → ready
Added `services/gateway/src/routes/orb-live.ts` to paths (and tasks.md Allowed paths identically) for the
F1/F2/F3 fixes: the SYNC `buildLiveSystemInstruction` keeps its signature and receives a pre-fetched tenant
config as a parameter (call site `orb-live.ts:7678`), and `buildAnonymousSystemInstruction` is extracted
verbatim into `orb/live/instruction/anonymous-system-instruction.ts` (snapshot-gated) leaving a ~3-line
import+call. Verified: `buildLiveSystemInstruction` is sync and reads `getPersonalityConfigSync`
(`live-system-instruction.ts:26,463,576,594`); `buildAnonymousSystemInstruction` spans `orb-live.ts:7413`–`:7541`
with Maxina literals (`:7437`, `:7492`) on the no-JWT anonymous path (`:7651`); `buildFirstTimeWelcomeLine`
(`greeting-pools.ts:177`) emits finished Maxina sentences (`:181`–`:186`). No seat/reviewer/dep change.

### 2026-10-20T16:55Z · kiro-hotmail-202610151618-b437 · spar session 2 round 1 (eb308b4e) — paths changed
R1-F1..F4. Named the sync per-tenant primitive (`tenantConfigCache`, `prewarmEffectiveConfig`, `getEffectiveConfigSync`; `getPersonalityConfigSync` itself is at `ai-personality-service.ts:460`); delete dead `buildFirstTimeWelcomeLine` + its test and extend `no-hardcoded-spoken-wording.test.ts`; exact anonymous slug contract (`LiveSessionStartRequest.tenant_slug`, `getTenantIdBySlug`, `anonTenantId`) and the enumerated `orb-live.ts` diff; FIXED/TENANT field map for `voice_live`. `paths` + `live-session-controller.ts`, `orb/live/types.ts`, `tenancy/tenant-context.ts`, `compute-greeting-decision.ts`, the two test files. No other lane claims them.

### 2026-10-20T17:10Z · kiro-hotmail-202610151618-b437 · spar session 2 round 2 — no path change
R2-F1/F2: the first-time welcome directive (`compute-greeting-decision.ts:1233`) reads an optional `GreetingDecisionContext.communityName` (default `'Maxina'` = today's exact string), set from `session.packFacts` at the three `orb-live.ts` context literals; `PackFacts`/`MAXINA_PACK_FACTS` defined. `compute-greeting-decision.ts` was already in `paths`.
