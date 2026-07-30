# LiveKit migration plan

**Status:** Skeleton landed. No production traffic on LiveKit. Vertex is the only path that actually carries voice.

This doc describes how the ORB Live voice path can be migrated from Vertex AI Live (the current single provider) to LiveKit, using the provider-neutral `UpstreamLiveClient` boundary introduced by A7. It is intentionally written as a *gap analysis* so the next implementer can see what is and is not modeled by the current interface.

---

## 1. Current Vertex path (what exists today)

End-to-end shape:

```
client browser/app
   │  WSS (or SSE/REST stream — A9.x)
   ▼
gateway: services/gateway/src/routes/orb-live.ts
   │  per-session: connectToLiveAPI(...)        ← single call site, still inline
   ▼
Vertex AI Live API
   wss://${location}-aiplatform.googleapis.com/.../BidiGenerateContent
```

Key behaviors of the Vertex path:

- **Single bidi WebSocket** per session. Setup envelope sent once; everything else flows over the same socket.
- **Server-driven VAD.** Vertex detects end-of-speech via `silence_duration_ms`. The client streams raw audio chunks (`realtime_input.media_chunks[]`) and Vertex decides when the turn ends.
- **Audio-out as inline base64** under `server_content.model_turn.parts[].inline_data` (24 kHz PCM mono).
- **Transcripts** as text deltas under `server_content.input_transcription` and `output_transcription`.
- **Tool calls** as `tool_call.function_calls[]`.
- **Auth** via Google OAuth access token (one per `connect()`), passed as `Authorization: Bearer …`.
- **Session lifecycle, watchdogs, persona, memory context, OASIS events** all live in `routes/orb-live.ts` — outside the upstream boundary.

A7 (PR #2081, VTID-02956) extracted the wire-shape work into `VertexLiveClient` (in `services/gateway/src/orb/live/upstream/vertex-live-client.ts`). The legacy inline `connectToLiveAPI` in `routes/orb-live.ts` is still the production call site; the swap is A8/A9 work.

## 2. Intended LiveKit path

End-to-end shape:

```
client browser/app                    ┐
   │  WebRTC (or WS for media)        │
   ▼                                  │
LiveKit SFU (Cloud or self-hosted)    │  same room
   ▲                                  │
   │  agent participant               │
gateway: dispatched LiveKit Agent     ┘
   │  internally calls LLM + TTS providers
   ▼
LLM provider (e.g. Gemini, Claude, OpenAI)
TTS provider (Google, ElevenLabs, …)
STT provider (Deepgram, Google, …)
```

Key shape differences from Vertex:

- **Room + tracks**, not a single bidi socket. The gateway joins the room as an agent participant and publishes/subscribes audio tracks.
- **Client-side participant** publishes the user's mic audio to the room directly. The gateway no longer relays raw audio chunks — that path goes browser → SFU → agent.
- **VAD lives in the agent**, not the model. LiveKit Agents bundle Silero VAD + STT + LLM + TTS in a turn-detector loop the gateway implements.
- **Auth via short-lived participant JWT** signed with `LIVEKIT_API_SECRET`. The gateway mints tokens for both itself (agent) and the user.
- **Tool calls / events ride a data channel** alongside the audio tracks (or are handled entirely server-side inside the agent loop).
- **Reconnect = re-publish track**, not re-open a socket.

What LiveKit gives us in exchange:

- WebRTC reliability + congestion control + jitter buffering (vs. raw WS audio).
- Pluggable LLM / STT / TTS providers (we are no longer locked to Vertex's model+voice combo).
- Multi-participant capability (e.g. listen-in, hand-off, recording) without rewiring the audio path.

## 3. What `UpstreamLiveClient` already supports

The interface (in `services/gateway/src/orb/live/upstream/types.ts`) cleanly models the Vertex shape:

| Capability | Interface surface | LiveKit fit |
|---|---|---|
| Connect / handshake | `connect(options) → Promise<void>` | ✅ — maps to `Room.connect()` after token mint. |
| Lifecycle states | `getState()` over `idle / connecting / open / closing / closed / error` | ✅ — Room emits matching connection-state changes. |
| Forward user audio | `sendAudioChunk(b64, mime)` | ⚠️ — Wrong direction. With LiveKit, the *client* publishes audio to the SFU; the gateway subscribes. See gap §4.1. |
| End-of-turn signal | `sendEndOfTurn()` | ⚠️ — Vertex has explicit end-of-turn; LiveKit's agent loop infers turn end from VAD. Becomes a no-op or maps to a data-channel hint. |
| Text turn fallback | `sendTextTurn(text, complete)` | ✅ — maps to data-channel message into the agent. |
| Audio output | `onAudioOutput({ dataB64, mimeType })` | ⚠️ — LiveKit publishes audio as a *track*. Either (a) the gateway subscribes and re-emits chunked audio over its own WS to the browser (preserves current frontend contract), or (b) the browser subscribes directly to the agent's track (changes the frontend contract). See gap §4.4. |
| Transcripts | `onTranscript({ direction, text })` | ✅ — STT/TTS plugins emit transcript events the agent can forward via data channel. |
| Tool calls | `onToolCall({ calls })` | ✅ — agent surfaces LLM tool calls to the gateway via data channel. |
| Turn complete | `onTurnComplete({ durationMs })` | ✅ — agent emits at end of TTS playback. |
| Interrupted | `onInterrupted({ atMs })` | ✅ — VAD-driven barge-in maps cleanly. |
| Errors / close | `onError`, `onClose` | ✅ — Room disconnect / failure events map directly. |

## 4. Gaps the interface does not yet model

The skeleton `LiveKitLiveClient` honors the *contract* of `UpstreamLiveClient` (lifecycle, idempotency, send-returns-false-when-not-open). It does not implement provider behavior because the items below have no home in the current interface.

**Rule for the next implementer:** do NOT mutate `types.ts` opportunistically. Each gap below should be a discrete, reviewable change with an explicit migration note added to this doc.

### 4.1 Audio direction & track lifecycle

`UpstreamLiveClient.sendAudioChunk()` assumes the gateway forwards raw audio chunks from the user to the model. LiveKit inverts that: the user joins the room and publishes audio directly; the agent subscribes.

Options:
- **A.** Add `subscribeToParticipantAudio(identity)` and demote `sendAudioChunk` to optional. Cleanest, but a real interface change.
- **B.** Keep `sendAudioChunk` and have the LiveKit client open a server-side audio publication on the gateway's behalf, re-encoding chunks. Preserves the interface but adds latency and a useless re-encode step.

A is the right answer when the time comes. The skeleton does not pick.

### 4.2 Room + participant identity

`UpstreamConnectOptions.projectId` and `location` are Vertex-specific. LiveKit needs:
- **room name** (typically derived from `sessionId`),
- **participant identity** (gateway-side and, separately, a token to hand back to the user),
- optional **room metadata** (locale, persona, debug toggles).

Today these are stored on the `LiveKitClientConfig` passed at construction time. That is correct for the skeleton (caller picks them) but the interface should grow a `roomContext?: { name, identity, metadata? }` field on `UpstreamConnectOptions` so the same call site can drive both providers without a discriminated union.

### 4.3 Token minting

`getAccessToken: () => Promise<string>` returns a Google OAuth token. LiveKit needs a participant JWT, not OAuth — different signing key (`LIVEKIT_API_SECRET`), different claims (`video`, `roomJoin`, `roomCreate`), different TTL story (typically 10 minutes; renewal happens by reconnecting).

Options:
- Generalize the contract to "credential supplier" with a provider-neutral string return, and let each implementation decide how to use it. (Cheap.)
- Add a typed credential discriminator (`{ kind: 'oauth_bearer', token } | { kind: 'jwt', token }`). (More honest, easier to typo-proof.)

Either works. The skeleton does not pick.

### 4.4 Audio output to the browser

The current frontend contract (in both the gateway-served `orb-widget.js` and the orb-live SSE/REST/WS transports the A9.x track is splitting out) expects base64 PCM audio chunks delivered over the gateway's own WS/SSE channel. `onAudioOutput({ dataB64, mimeType })` is shaped for that.

For LiveKit, two end-states:
- **Bridge mode (default).** Gateway subscribes to the agent's audio track, decodes/re-encodes to base64 PCM, and emits via `onAudioOutput`. Frontend stays unchanged. Costs latency + CPU.
- **Direct WebRTC mode.** Browser joins the room directly and subscribes to the agent's track. Removes the gateway hop entirely. Requires changes in `vitana-v1` and the gateway-served orb widget — out of scope for the gateway-only migration.

The skeleton assumes bridge mode is the first cut.

### 4.5 Reconnect + resume

Vertex reconnect = open a new bidi socket and re-send the setup envelope. The current orb-live.ts owns this (transparent reconnect logic, mic resume, audio-out resume).

LiveKit reconnect = LiveKit SDK has its own reconnect with token refresh. The interface has no concept of "reconnected to the same logical session" — it just exposes `onClose` and the caller decides to construct a new client.

Either:
- The selection seam constructs a fresh `LiveKitLiveClient` per reconnect (matches today's Vertex flow; loses the SDK's built-in resume).
- We introduce `connect()` semantics that distinguish first connect from reconnect (real interface change).

Decide when reconnect storms are observed in dogfood — not before.

### 4.6 Disconnect classification

Today's classifier in orb-live.ts (forwarding watchdog, response watchdog, transparent reconnect bucket) reads close codes from the Vertex socket. LiveKit reports disconnect *reasons* (`SIGNAL_FAILED`, `SERVER_LEAVE`, `PARTICIPANT_REMOVED`, …) with no overlap to WebSocket close codes.

`UpstreamCloseEvent.code?: number` is too narrow. Add `reasonClass?: 'transient' | 'auth' | 'server' | 'local' | 'unknown'` so callers can keep the same recovery logic without learning two vocabularies.

### 4.7 Frontend contract

The frontend currently expects:
- Initial greeting audio within ~2 s (iOS keep-alive depends on this).
- Transcript stream interleaved with audio.
- WS or SSE endpoint per `sessionId`.
- Reconnect via the same `sessionId` is transparent (same greeting suppression, same continuation).

In bridge mode (§4.4), the contract is preserved. In direct WebRTC mode, the frontend learns to:
- Mint participant tokens via a new gateway endpoint (`/api/v1/orb/livekit/token`).
- Subscribe to the agent participant's audio track instead of decoding `data` events.
- Receive transcripts/tool-call notifications via LiveKit data channel rather than SSE/WS frames.

Bridge mode first; direct WebRTC behind an explicit per-tenant flag once parity is proven.

## 5. Selection rules (shipped in this PR)

`services/gateway/src/orb/live/upstream/provider-selection.ts`:

```
ORB_LIVE_PROVIDER unset   → vertex   (source: 'default')
ORB_LIVE_PROVIDER=vertex  → vertex   (source: 'env')
ORB_LIVE_PROVIDER=livekit AND LIVEKIT_URL/API_KEY/API_SECRET set
                          → livekit  (source: 'env')
ORB_LIVE_PROVIDER=livekit AND any cred missing
                          → vertex   (source: 'fallback', warning lists missing vars)
ORB_LIVE_PROVIDER=<other> → vertex   (source: 'fallback', warning names value)
```

The `warnings[]` field is the contract for telemetry. When the call site wires this in, it must emit one OASIS event per warning so a misconfigured rollout cannot fail silently.

Selection is per-session (the function is pure). When tenant-level overrides land (e.g. `tenant_settings.voice_provider`), wrap or replace `selectUpstreamProvider` — do not mutate it to read from the database; that breaks the unit-test contract.

## 6. Risks

- **Audio latency in bridge mode.** Gateway becomes a transcoder. Dogfood before flipping any tenant.
- **Token leakage.** LiveKit JWTs grant room access. The mint endpoint must be authenticated and the JWT must be short-lived.
- **Cost shape changes.** Vertex bills per audio second; LiveKit Cloud bills per participant minute. Provider-by-tenant means cost analytics must split per provider.
- **Two reconnect mental models.** Dual-running both providers in production multiplies the disconnect-classification surface — keep `LIVEKIT_*` traffic on a small canary cohort until §4.6 lands.
- **Skeleton drift.** If A8/A9 evolve `UpstreamLiveClient` to fit Vertex more tightly (e.g. add Vertex-only fields), the LiveKit gap list grows. Each interface change should re-review §4 and update the gap.

## 7. Out of scope for the skeleton

The following are explicitly NOT touched by this PR:
- `routes/orb-live.ts` and the inline `connectToLiveAPI` (still the production call site).
- `orb/live/transport/*` (WS / SSE / REST stream — A9.x territory).
- `orb/live/instruction/*` (decision-contract renderer / system instruction composition).
- Frontend orb widget audio playback path.
- Reliability tuning (timeouts, watchdogs, reconnect cadence).
- Any behavior change for the Vertex path.
