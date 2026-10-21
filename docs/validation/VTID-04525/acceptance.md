# VTID-04525 — Conversation hub rebuild, Phase A (backend foundation)

Plan: `docs/CONVERSATION-HUB-REBUILD-PLAN.md` §5, §6 (B1, B2, B3, B7), §8 Phase A.
Phase A is backend only. The tabs that show this data are Phase B.

## What ships

- **B1** `GET /api/v1/admin/conversation/system`: what the conversation system
  is made of on this process, built from the code a live session runs.
  - Tools per session shape: anonymous landing, anonymous app page, community,
    developer, Command Hub, admin, backoffice, commerce.
  - Each tool's classifier result, and whether each provider's byte budget
    trims it.
  - The opening providers from the live registry, both provider timeouts, every
    greeting rung, and every conversation flag.
  - A per-build `conversation.system.snapshot` event, recorded only when the
    fingerprint differs from the last one for the same stack, with a diff.
  - `GET /api/v1/admin/conversation/system/history` returns the recorded
    snapshots and their diffs.
- **B7** Conversation flag registry: 42 flags. Each reports its raw value,
  effective value, code default, parse rule, validity, and the pins declared
  in both gateway deploy workflows. Effective values come from the owning
  module's own read function wherever one exists. The pins are generated from
  the workflows by `scripts/conversation/generate-flag-pins.mjs`.
- **B2** The system-instruction byte budget is now an `orb.live.diag` stage
  (`instruction_budget`) on every upstream setup. It was console-only. The
  session inspector summarizes it.
- **B3** `GET /api/v1/admin/conversation/aggregates?hours=`, over a bounded
  window:
  - per tool: calls, failures, p50/p90 latency;
  - guard fires: loop guard (opening vs later), opening refusals, reply cap,
    backend-data mutes, catalog trims, instruction budget trim rate;
  - the opening mix.

## Acceptance criteria

AC-1: The three new routes return 401 signed out and 403 for a non-admin.
TEST: services/gateway/test/routes/vtid-04525-conversation-hub-phase-a-routes.test.ts

AC-2: The snapshot's per-session tool counts equal what `buildLiveApiTools` returns for the same arguments. Its Nova budget view equals `enforceToolCatalogBudget` on the same catalog.
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-system-introspection.test.ts

AC-3: Opening providers equal the live provider registry. Every greeting rung is listed (compile-time exhaustive). The two switchable rungs report their switch.
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-system-introspection.test.ts

AC-4: The fingerprint ignores the timestamp and changes when a flag or rung switch changes. The snapshot event is emitted only on a change. A failed emit is reported, never thrown.
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-system-introspection.test.ts

AC-5: Each flag's effective value follows its parse rule. Every inline mirror matches the source expression it mirrors. Invalid raw values are flagged. VTIDs are real or null, never invented.
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts

AC-6: The generated workflow-pins file is current. Changing a pin in a workflow fails the suite.
TEST: services/gateway/test/services/conversation/vtid-04525-conversation-flag-registry.test.ts

AC-7: The setup path emits `instruction_budget` with sizes and section kinds only, and the session inspector summarizes it.
TEST: services/gateway/test/routes/vtid-04525-conversation-hub-phase-a-routes.test.ts

AC-8: Aggregates are computed from stage-filtered, windowed reads and match a fixed fixture.
TEST: services/gateway/test/routes/vtid-04525-conversation-hub-phase-a-routes.test.ts

## Route evidence

ROUTE_MOUNT: `routes/conversation-hub.ts` is mounted at `/api/v1` (unchanged). It adds `GET /admin/conversation/system`, `GET /admin/conversation/system/history` and `GET /admin/conversation/aggregates`, each behind `requireAuth` + `requireExafyAdmin`.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/conversation/system (plus `/system/history` and `/aggregates`)
CURL_PROOF: before this PR, signed out: see `outputs/staging-before.txt`. The routes do not exist yet, so Express answers with its HTML 404. After merge, a signed-out curl must return `401 application/json`, which proves the route is mounted and gated.

## Findings the snapshot already shows (from this checkout, not staging)

- 3 tools have an ORB registry handler but are declared on no surface:
  `offer_action`, `recall_conversation_at_time`, `search_web`.
- 15 tools are classified only by the fallback rule. Examples: `append_to_ticket`,
  `mark_intent_fulfilled`, and several `admin_*` / `backoffice_*` tools.
- A signed-in community session declares 293 tools (228 KB). The Nova budget
  keeps 43, and 259 tools are left out of the setup on every session that
  declares them. That is by design, and they stay reachable via `find_tool`
  where `ORB_TOOL_SELECTION_ENABLED` is on (staging).
- `ORB_LIVE_ADVISOR_ENABLED` is pinned on neither stack.

## Not verified here

The routes have not run on staging with an admin bearer, because this session
has none. After the merge deploys, a signed-out curl confirms each route is
mounted and gated. The deploy's `conversation.system.snapshot` event in
`oasis_events` (read-only query) confirms the introspection runs in the real
process. `instruction_budget` diags appear once real sessions run on staging.
