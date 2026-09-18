# VTID-04036 — Vertex Serbian bridge: the model goes silent after any tool call (function-call `id` not echoed)

## Reported

Platform owner, live on staging, post-login Serbian ORB voice, one hour
after VTID-04026 shipped: "something is wrong with the speech recognition
… it does not even understand the simplest question."

## What the logs actually show (read-only, `oasis_events`)

Speech recognition is fine. Every `input_transcription` in the three
reported sessions (user `0adc6ff6…`, 23:06–23:12 UTC, 2026-09-17) is clean
Serbian:

| session | turn | transcript (concatenated previews) | what followed |
|---|---|---|---|
| `…d8aa2ed7ecf7` | 1 | "Ne nego hoću da znam kako mi stoji Vitana indeks." | model spoke (audio_out 199 → 232) |
| `…d8aa2ed7ecf7` | 2 | "Na kojoj broj ci? Koji broj trenutno stoji moj vitana indeksa?" | `tool_call get_day_summary` → tool ran (562 ms, `response_sent:true`, "Vitana Index today: 72 …") → **10 s of nothing** → `turn_complete` with audio_out unchanged (232) |
| `…d8aa2ed7ecf7` | 3 | "Da me čuješ." | `tool_call get_current_screen` → result sent → **no audio** |
| `…d8aa2ed7ecf7` | 4 | "Halo, je me čuješ?" | **no audio** |
| `…d8aa2ed7ecf7` | 5 | `<noise>` | model started speaking, then `upstream_ws_close 1007 "Request contains an invalid argument."` mid-turn → widget reconnect |
| `…114a805af7dc` | 1 | "Pitam te kako stoji koji broj. Na kom broju …" | `tool_call get_day_summary` → result sent → **no audio ever**, user closed (1000) |
| `…806adac753cd` | 0 | greeting spoke | user closed at turn 1 (1000) |

Across every Serbian session of the previous 3 days, the number of
sessions that produced audio after a tool response is **zero**
(`outputs/oasis-trace-2026-09-17.txt`).

## Root cause

`VertexLiveClient.sendToolResult()` (and the identical envelope in
`gemini-api-key-live-client.ts` and the legacy
`sendFunctionResponseToLiveAPI` in `routes/orb-live.ts`) sent
`tool_response.function_responses[]` with only `name` and `response` —
the function-call `id` was deliberately omitted, on a VTID-01224-era note
that "Vertex rejects unknown fields like 'id' … with WS close 1007",
measured against `gemini-2.0-flash-exp`.

Google's current Live API reference (`ai.google.dev/api/live`,
`BidiGenerateContentToolResponse`): "Individual FunctionResponse objects
are matched to the respective FunctionCall objects by the `id` field."
The tools guide adds that the model does not start responding until it
has received the tool response. Without the id,
`gemini-live-2.5-flash-native-audio` never treats the pending call as
answered: the turn ends silent, the user hears nothing and repeats the
question, and the unanswered calls accumulate until the next generation
is rejected with 1007. The gateway already parses `fc.id` from the
server's `tool_call` and hands it to the client as `callId` — it was
dropped at the wire only.

## Fix

- `vertex-live-client.ts` / `gemini-api-key-live-client.ts`: remember the
  ids the server issued in `tool_call`; `sendToolResult` echoes
  `id: callId` when it is one of them (each id once). A callId the server
  never issued — the session layer substitutes `randomUUID()` for a call
  that arrives without one — is not echoed.
- `routes/orb-live.ts` legacy `sendFunctionResponseToLiveAPI`: same,
  guarded by the new exported `isServerIssuedFunctionCallId()` (rejects
  the v4-uuid placeholder shape).
- Stale "id is rejected" comments replaced with the measured finding.

No change to Nova Sonic (`nova-sonic-live-client.ts` already requires the
id) or to the cascade; the Vertex bridge stays Serbian-only
(VTID-04000), and the tool-catalog budget (VTID-04026) is untouched.

## Acceptance criteria

AC-1: `VertexLiveClient.sendToolResult` echoes the server-issued
function-call id in `tool_response.function_responses[0].id`.
TEST: services/gateway/test/orb/live/upstream/vertex-live-client.test.ts
("sendToolResult echoes the server-issued function-call id (VTID-04036)")

AC-2: A callId the server never issued (the session layer's randomUUID
placeholder) is NOT echoed as an id.
TEST: services/gateway/test/orb/live/upstream/vertex-live-client.test.ts
("sendToolResult omits `id` when the callId was not issued by the server")
TEST: services/gateway/test/orb/live/upstream/gemini-api-key-live-client.test.ts
("sendToolResult omits `id` for a callId the server never issued")

AC-3: Each server-issued id is echoed exactly once, in any order.
TEST: services/gateway/test/orb/live/upstream/vertex-live-client.test.ts
("sendToolResult echoes each server-issued id once (VTID-04036)")

AC-4: The API-key client sends the same envelope shape with the id.
TEST: services/gateway/test/orb/live/upstream/gemini-api-key-live-client.test.ts
("sendToolResult sends the shared tool_response envelope")

AC-5: The legacy sender in routes/orb-live.ts echoes a server-issued id
and never the uuid placeholder; every `function_responses` sender in the
tree carries the echo (source contract).
TEST: services/gateway/test/orb/live/vertex-function-response-id.test.ts

AC-6: The provider-neutral session handler still routes tool answers
through `sendToolResult` with the callId on both providers (no
regression in the parity suite).
TEST: services/gateway/test/orb/live/session/upstream-provider-parity.test.ts
("answers the tool call through sendToolResult on both providers")

AC-7 (post-merge, live on staging): an authenticated `sr` session that
asks a question requiring `get_day_summary` gets a `tool_call`, a tool
result, and then `model_start_speaking` on the SAME turn, with no 1007.
Driven by `scripts/orb/verify-vertex-serbian-bridge.mjs
--mode=authenticated --utterance-pcm=<16 kHz PCM>`; confirmed in
`oasis_events` (`tool_call` → `orb.live.tool.executed` →
`model_start_speaking`, audio_out rising after the tool call).
CURL: see commands.log "AC-7" and outputs/live-verification-post-merge.txt.
RESULT (2026-09-18 07:14 UTC, staging on `0b24cd8`): **6/6** sessions —
`tool_call get_day_summary` → `orb.live.tool.executed response_sent:true`
→ `model_start_speaking` on turn 1, audio_out rising by ~350 chunks per
session, clean 1000 closes, 0 watchdogs, **0 × 1007**; first reply audio
1.2–2.1 s after the utterance ended. Baseline on the previous build
(`7c8c600`, outputs/live-baseline-before-fix.txt): 0/2 — tool response sent,
then 20 s of silence and `watchdog_fired`.

## Not touched, flagged

- `get_current_screen` returned the pre-login "Join the Maxina Community"
  screen (`/maxina`) for a logged-in session — the widget's reported
  `current_route`, not this VTID's concern.
- `voice.latency.measured` labels turns ≥ 1 as `gemini-2.0-flash-exp`
  (stale `GEMINI_MODEL` constant in `orb-live.ts`), cosmetic.
- The pre-login thinking-text-spoken bug (owner instruction: leave it).

## OASIS_PROOF

OASIS_PROOF: no new event topics. Existing `orb.live.diag`
(`tool_call`, `model_start_speaking`, `turn_complete`, `upstream_ws_close`)
and `orb.live.tool.executed` are the observation points; AC-7 reads them
back after the deploy.
