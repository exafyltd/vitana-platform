---
lane: persona-pack
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/src/services/ai-personality-service.ts
  - services/gateway/src/orb/profile/**
  - services/gateway/src/orb/live/instruction/**
  - services/gateway/src/orb/instruction/greeting-pools.ts
  - services/gateway/src/routes/orb-live.ts
  - services/gateway/src/orb/live/session/live-session-controller.ts
  - services/gateway/src/orb/live/types.ts
  - services/gateway/src/services/conversation/compute-greeting-decision.ts
  - services/gateway/test/orb/live/characterization/no-hardcoded-spoken-wording.test.ts
  - services/gateway/test/orb/instruction/first-time-welcome.test.ts
  - services/gateway/test/mt-packs-persona-*.test.ts
updated: 2026-11-01T15:40Z
repos: [exafyltd/vitana-platform]
---
# persona-pack — persona split + runtime getEffectiveConfig (repo vitana-platform)

Plan: `.kiro/specs/mt-packs-r2/plan.md` (authoritative) and the `persona-pack` section of `tasks.md` (P1–P4,
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

The VTID comes from PLAN-SPAR on convergence, never by hand.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes. Work only inside the allowed paths. Branch
`kiro/mt-packs-r2/persona-pack`; PR title `VTID-xxxxx (mt-packs-r2/persona-pack): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: mt-packs-r2/persona-pack`. When the PR is open: set
`state: in-review`, `next_actor: kiro`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-11-01T15:40Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-packs/persona-pack`. Answers R3-F1 (a scoped guard block; the live short-gap pool stays) and R3-F2 (the slug lookup comes from
`mt-identity-r2` T3b, so `tenant-context.ts` is dropped from `paths`).
