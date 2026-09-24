# VTID-04491 — Conversation hub rebuild, Phase 0 (B8)

Plan: `docs/CONVERSATION-HUB-REBUILD-PLAN.md` §6 B8, §8 Phase 0.

## What was wrong

1. `GET /api/v1/voice-tools/catalog`, `/catalog/stats` and `/catalog/:name`
   needed no auth. The route header said a mount-path gate protected them,
   but `mountRouterSync` only guards against duplicate routes. The full tool
   catalog (names, parameters, backing endpoints, roles) was readable by
   anyone.
2. `GET /api/v1/voice/next-action/inspector` ran `requireExafyAdmin` without
   `requireAuth`. `requireExafyAdmin` only reads `req.identity`, and nothing
   set it, so every request got 401, an admin's included. The Command Hub
   panel that reads the route could never load. This was fail-closed, so
   nothing leaked.
3. Monitor said the weighted score "changes nothing Vitana says". Since
   VTID-04454 the score can choose the opening.
4. The Awareness screens named Gemini Live as the voice model, and the Tool
   Catalog labelled the gateway transport "Vertex".

## Acceptance criteria

- **AC-1** The three catalog routes return 401 without a bearer and 403 for
  a signed-in non-admin; an exafy_admin still gets the catalog.
  `/voice-tools/health` stays public.
  TEST: services/gateway/test/routes/voice-tools-catalog.test.ts
- **AC-2** The next-action inspector runs `requireAuth` before
  `requireExafyAdmin`.
  TEST: services/gateway/test/routes/voice-next-action-inspector.test.ts
- **AC-3** The Tool Catalog screen sends the bearer via `buildContextHeaders()`.
  TEST: services/gateway/test/vtid-04491-conversation-hub-phase0.test.ts
- **AC-4** Monitor reports how many openings the score chose, and how many
  differ from the fixed-priority pick. It says "shadow mode" only for a
  window in which the score chose none.
  TEST: services/gateway/test/vtid-04491-conversation-hub-phase0.test.ts
- **AC-5** No Awareness string names Gemini Live as the voice model, and the
  Tool Catalog labels the gateway transport "Gateway".
  TEST: services/gateway/test/vtid-04491-conversation-hub-phase0.test.ts
- **AC-6** Both cache-busts were bumped together.
  TEST: services/gateway/test/vtid-04491-conversation-hub-phase0.test.ts

## Mutation checks

- Removing the bearer from the catalog fetch fails the Phase 0 suite (1 test).
- Removing the gate from `/catalog/stats` fails the catalog suite (3 tests).

## Not verified here

The routes were not called on staging with a real admin session, because
this session has none. After merge, check on staging:

- Conversation › Tool Catalog still loads. It now sends the bearer.
- The candidate-inspector panel, which reads
  `/voice/next-action/inspector`, loads rows instead of failing with 401.
- A signed-out `curl` of `/api/v1/voice-tools/catalog` returns 401 JSON.
