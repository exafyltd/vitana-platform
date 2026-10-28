# Raw Vertex handler (A) vs shared upstream handlers (B) — feature diff (2026-09-23, read-only)

- **(A):** `createUpstreamLiveMessageHandler` (`orb/live/session/upstream-message-handler.ts` ~272–1590). Used only by the Vertex path in `routes/orb-live.ts`, attached with `ws.on('message', …)`.
- **(B):** `bindUpstreamSessionHandlers` (~2698) with `handleAudioOutput`, `handleTranscript`, `handleToolCall`, `handleTurnComplete`, `handleInterrupted`, `handleUsage`, `handleUpstreamError` and `handleUpstreamClose`. Used by Nova Sonic and the cascade.

## Client surface

`VertexLiveClient` implements `UpstreamLiveClient` and emits every event (B) binds to:

| Event | Emitted? |
|---|---|
| audio | yes |
| transcripts, both directions | yes, as streamed deltas |
| tool calls | yes, with the server-issued ids recorded |
| turn complete | yes |
| interrupted | yes |
| error | yes |
| close | yes |
| usage | never fires |

GoAway and session resumption are registered on the client by the route and are unaffected by the switch.

## Unique to (A)

1. **Clearing consumed tool results at turn complete.** Ported to (B) in VTID-04418; this was a live gap for Nova and cascade too.
2. **The `notifyOrbVoiceBridgeWrite` push** after the Vitana→user chat write (VTID-03520). Not ported: an owner decision.
3. **Model text parts** forwarded to `onTextResponse`. Not exposed by the client; Vertex bridge sessions are audio.
4. **Stopping at an interruption within a frame.** Ported into both Vertex clients.
5. **Unconditional silence-keepalive re-arm.** Covered by passing `enableSilenceKeepalive: true`.

## Unique to (B)

1. **The still-here backstop.** The deps were passed to (A) but never called.
2. **Graceful tool-loop guidance** and the hard-ceiling alert.
3. **A per-turn reset of the model-responded flag.** (A) never resets it, so the no-ack watchdog stayed off after the first model audio.
4. **A strict server-issued id echo** on tool results.
5. **Extra diags:** `usage_totals`, `upstream_error` with `failure_kind`, `upstream_closed`, `persona_swap_in_process`.

## Wiring

- **Bind (B) before `connect()`** and do not register (A). With both, every frame would be processed twice.
- **Skip binding error and close** (`bindConnectionEvents: false`). The route's raw-socket handlers stay; binding them too would send the user a second error frame.
