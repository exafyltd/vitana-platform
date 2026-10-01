# VTID-04426 — Conversation rebuild WS-3.4: tool choice per session

This is Plan v1 (Conversation Intelligence Rebuild), Phase 3, workstream WS-3.4. It ships in PR #3614 as a companion to VTID-04339.

## Why

The per-provider tool-catalog budget (VTID-04026 for Vertex, VTID-04097 for Nova) keeps a fixed priority list and then fills the rest of the byte budget in catalog order. Measured against the real signed-in community catalog at the default 64 KB Nova budget, **43 of 291 tools are declared and 248 are silently dropped**. The dropped tools include:

- health logging beyond water and sleep;
- the whole wallet;
- shopping and orders;
- goals and diary history;
- `get_next_best_action` (WS-2.3).

A user on the Wallet screen asking for their balance reached a model with no wallet tool at all.

Nova's tool list is fixed for the life of a stream (WS-3.1, VTID-04424). So "choose tools mid-session" has to mean two things:

- choose well at connect time;
- reach the rest through tools that are always declared.

## Change (`orb/live/tools/session-tool-selection.ts`, behind `ORB_TOOL_SELECTION_ENABLED`)

- **Selection.** The budget does not change; only the fill order does. When the budget has to trim, the order is:
  1. `find_tool` and `use_tool`;
  2. the existing priority list;
  3. `get_next_best_action`;
  4. the current screen's tools;
  5. catalog order, as before.

  The screen's tools come from a small route → tool-name-stem map. Stems are most important first, because only ~6 KB is left after the base list.
- **Reach.**
  - `find_tool(query)` searches the tools the budget dropped for this stream and returns up to 6 names, bounded descriptions and parameter schemas. A tool must match at least half of the query's words.
  - `use_tool(name, arguments_json)` runs one of them through the normal dispatcher: `executeLiveApiTool`, with the same timeouts, auth and handlers.
  - Only tools that were in this session's own catalog are reachable, so surface gating still applies. Directly declared tools, unknown tools and the meta tools themselves are refused.
- **Safety net.** If the meta tools do not survive the budget, the session keeps the pre-VTID catalog unchanged.
- **Observability.**
  - `tool_catalog_trimmed` carries `selection`, `route_groups`, `contextual_kept` and `deferred_reachable`.
  - New `orb.live.diag` stages: `deferred_tool_search` (result count) and `deferred_tool_used` (tool).
  - The brain inspector's Tool catalog tile shows the screen groups, the screen tools kept, how many tools are reachable, the `find_tool` count and the tools `use_tool` ran (Command Hub; `?v=` bumped).
- **Flag.** `ORB_TOOL_SELECTION_ENABLED` is exact-string `true`. It is pinned on `AWS-STAGE-DEPLOY-GATEWAY.yml` only; production is unchanged.

## Acceptance

AC-1: The flag is on only for the exact string `true`, and is pinned on staging only.
TEST: services/gateway/test/orb/live/tools/vtid-04426-session-tool-selection.test.ts

AC-2: Against the real signed-in catalog and the Nova budget, the selection keeps the meta tools, every base priority tool and `get_next_best_action`, within the same budget. It also fits the Vertex bridge budget.
TEST: services/gateway/test/orb/live/tools/vtid-04426-session-tool-selection.test.ts

AC-3: The current screen's tools are declared: wallet tools on /wallet; `log_meal`, `log_mood` and `get_lab_results` on /health.
TEST: services/gateway/test/orb/live/tools/vtid-04426-session-tool-selection.test.ts

AC-4: Every tool the budget drops stays reachable, and declared plus deferred cover the whole catalog.
TEST: services/gateway/test/orb/live/tools/vtid-04426-session-tool-selection.test.ts

AC-5: `find_tool` finds the right tool for plain English queries, bounds its output and refuses one-word incidental matches.
TEST: services/gateway/test/orb/live/tools/vtid-04426-session-tool-selection.test.ts

AC-6: `use_tool` runs only deferred tools, with parsed arguments. It refuses declared tools, unknown tools, itself and bad arguments, and re-enters the normal dispatcher.
TEST: services/gateway/test/orb/live/tools/vtid-04426-session-tool-selection.test.ts

AC-7: The brain inspector shows the selection and the tools reached; without selection the summary is unchanged.
TEST: services/gateway/test/orb/live/tools/vtid-04426-session-tool-selection.test.ts

## Visual check

The Conversation → Simulator inspector was captured at 1400×900 and 390×844 against a local harness: `outputs/simulator-*-tools.png`, `outputs/shoot-report.json`.

- The harness feeds the real selection on the real catalog for a `/wallet` session, and a real `find_tool` result.
- There is no horizontal overflow and no page errors.

## Not verified live

Staging cannot place ECS tasks yet. After deploy, open a voice session on the Wallet screen and ask for the balance. Expected:

- a `tool_catalog_trimmed` diag with `selection:'context'` and `route_groups:['wallet']`;
- the balance answered from a directly declared wallet tool.

Then, from another screen, ask to log a meal. Expected: `deferred_tool_search`, then `deferred_tool_used` with `log_meal`.

How often the model reaches for `find_tool` without a prompt rule is not known until it runs. The tool's description carries the instruction ("never tell the user you cannot do something before you have tried find_tool").
