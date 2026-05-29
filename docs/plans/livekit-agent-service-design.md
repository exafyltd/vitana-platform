# L2.2b — Backend LiveKit Agent service design

**VTID:** VTID-02985
**Status:** Draft — design only. Implementation gated on approval.
**Predecessors:** L1 (VTID-02976), L2.1 (VTID-02980), L2.2a (VTID-02982).

---

## 1. Background

The ORB voice pipeline has two upstream providers:

- **Vertex** (production today): frontend → gateway WebSocket/SSE → `connectToLiveAPI` → Vertex AI Live API. The gateway sits in the audio path. L1 selector decides "which upstream client" inside `connectToLiveAPI`.
- **LiveKit** (frontend already wired, backend partly scaffolded): frontend uses `livekit-client` SDK to join a LiveKit room over WebRTC. The gateway only mints a room JWT via `POST /api/v1/orb/livekit/token`. The audio peer on the AI side is a **backend agent process** that joins the same room, runs STT/LLM/TTS, dispatches tools.

L2.2a closed the per-identity canary gap at `GET /api/v1/orb/active-provider` AND added a hard safety pin: `voice.livekit_agent_enabled` must be true before any caller can route to LiveKit. The flag is off in production. **L2.2b flips the flag on** — by building (or finishing) the backend agent service that owns the LiveKit-side audio peer.

**Crucial finding from L2.2a research:** a substantial skeleton already exists at [`services/agents/orb-agent/`](../../services/agents/orb-agent/). Python `livekit-agents` worker, Cloud Run service.yaml, Dockerfile, manifest.json with provider policy, 18+ `@function_tool` wrappers drafted in `tools.py`, agent entrypoint + room lifecycle in `session.py`. This design doc **ratifies the existing decisions** and **sequences the remaining work**, rather than designing from scratch.

---

## 2. Decisions (anchored to the existing skeleton)

### 2.1 Runtime: Python `livekit-agents` (already decided)

Files: [`services/agents/orb-agent/main.py`](../../services/agents/orb-agent/main.py), [`services/agents/orb-agent/requirements.txt`](../../services/agents/orb-agent/requirements.txt), [`services/agents/orb-agent/pyproject.toml`](../../services/agents/orb-agent/pyproject.toml).

**Justification (recorded, since the skeleton already committed):**
- `livekit-agents` (Python) is the **first-class** LiveKit Agents SDK with the deepest plugin ecosystem (Deepgram, AssemblyAI, Cartesia, ElevenLabs, Rime, Inworld, OpenAI Realtime, Anthropic) and idiomatic `@function_tool` declarations. The Node/TS equivalent (`@livekit/agents-js`) is newer and has fewer plugins, particularly around provider failover.
- The "LiveKit must perform 100%" memory feedback requires multi-provider STT/LLM/TTS cascades with quota failover. The Python plugin set already covers Deepgram + Cartesia + Anthropic out of the box.
- Workforce and other agents in `services/agents/` are mixed Node/Python. A new Python service does not increase polyglot footprint.
- **Trade-off accepted:** type-checking parity with the rest of the gateway TypeScript codebase is reduced. Mitigated by `mypy` in CI (already in `package.json` scripts) + tool surface defined via a single shared manifest, not a hand-typed enum.

### 2.2 Deployment: Cloud Run scale-to-zero (already decided)

Files: [`services/agents/orb-agent/service.yaml`](../../services/agents/orb-agent/service.yaml), [`services/agents/orb-agent/Dockerfile`](../../services/agents/orb-agent/Dockerfile).

- **Target:** Cloud Run service `vitana-orb-agent` in `lovable-vitana-vers1` / `us-central1` (matches platform rules).
- **Autoscale:** `minScale: 0`, `maxScale: 10`. Scale-to-zero is critical — when LiveKit is the standby provider, no compute runs.
- **Concurrency:** `containerConcurrency: 25`. A single agent process holds open WebSocket connections to LiveKit + STT + LLM + TTS providers per active room; 25 is conservative until measured.
- **CPU/memory:** `2 vCPU / 4 Gi`. Tight for a single Python process holding 25 streaming pipelines; revisit after first canary.
- **Cold-start:** ~1–2 s on first room join after the agent flag is flipped. Acceptable for a canary.
- **Secrets (all via Secret Manager `secretKeyRef`):** `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `GATEWAY_SERVICE_TOKEN`, plus optional provider keys (`ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, `ELEVENLABS_API_KEY`, `ASSEMBLYAI_API_KEY`).
- **Ingress:** `internal-and-cloud-load-balancing`. The agent doesn't serve public HTTP; it only opens outbound WebSockets to LiveKit + Anthropic + STT/TTS providers, plus REST calls to the gateway.
- **EXEC-DEPLOY integration:** PR ‑#8 (per `service.yaml` annotation) is the remaining wiring to deploy the agent through the canonical pipeline. Until that lands, manual `gcloud run services replace service.yaml` is the deploy path.

### 2.3 Room lifecycle

The mint-token route already exists. The dispatch + cleanup are the gaps.

**Who creates the room:** The frontend triggers it by calling `POST /api/v1/orb/livekit/token` ([`orb-livekit.ts`](../../services/gateway/src/routes/orb-livekit.ts)). The gateway returns `{url, token, room, orb_session_id}` — `room` is a unique name (today: `orb-{user_id}-{rand}` per the route impl). The room is **lazily created** by LiveKit on first peer join; no separate "create room" call.

**Who mints the user token:** Gateway, via `AccessToken` from `livekit-server-sdk`, signed with the API key/secret pair. The token grants `roomJoin + canPublish + canSubscribe` for that one room.

**Who starts the agent:** A LiveKit Agents `Worker` registered with the LiveKit SFU. The SFU **dispatches a job** for each new room based on a `JobRequest`-time filter the worker subscribes to (room-name prefix `orb-*` or metadata flag `agent_required: true`). The agent's `agent_entrypoint(JobContext)` is the worker's per-room handler.

**When the agent joins:** Immediately after the SFU dispatches the job. The frontend's `useLiveKitVoice` calls `room.connect(url, token)`; the SFU notifies the worker of a room creation that matches the filter; the worker spawns a participant; both peers are now in the room. The room metadata carries the `orb_session_id` so the agent can `GET /api/v1/orb/context-bootstrap?orb_session_id=...` for the system instruction + persona + tools (see §2.5).

**When the agent leaves:** Triggered by either side disconnecting. `session.py` already wires `agent_entrypoint` cleanup — on `Room.Disconnected` the agent emits `livekit.session.stop` and unwinds STT/LLM/TTS pipelines. LiveKit garbage-collects the empty room after a short TTL (default 5 min, configurable).

**Cleanup / TTL:**
- Room empty (no peers) → LiveKit GC after TTL.
- Agent crashes mid-session → SFU detects via heartbeat loss → another worker can be dispatched (if `maxScale` allows) OR the user's `room.connect` retry path triggers a new dispatch.
- User disconnects mid-turn → agent waits 30s for reconnect, then emits stop + leaves.

### 2.4 Audio pipeline

Already scaffolded in [`services/agents/orb-agent/src/orb_agent/providers.py`](../../services/agents/orb-agent/src/orb_agent/providers.py) and [`session.py`](../../services/agents/orb-agent/src/orb_agent/session.py).

```
[Browser mic]  --(WebRTC audio track)-->  [LiveKit SFU]  --(audio track)-->  [Agent process]
                                                                                  |
                                                                                  ▼
                                                                              [STT plugin: Deepgram default]
                                                                                  |
                                                                                  ▼
                                                                              [LLM plugin: Anthropic Sonnet 4.6 default]
                                                                                  |
                                                                                  ▼
                                                                              [TTS plugin: Cartesia Sonic-3 default]
                                                                                  |
                                                                                  ▼
[Browser speakers] <--(WebRTC audio track)-- [LiveKit SFU] <--(audio track)-- [Agent process]
```

- **Providers configurable per agent** via `voice_providers` + `agent_voice_configs` Supabase tables (already created by the PR #1156 migration referenced in `orb-livekit.ts`). The agent calls `providers.build_cascade(persona, lang, tenant)` to assemble the chain at session start.
- **Cascade vs Realtime:** L2.2b ships the **cascade** path (STT → LLM → TTS as three plugin calls). The provider policy allows a `livekit_realtime` model (e.g. OpenAI Realtime / Gemini Live via LiveKit's realtime plugin) as a separate config row; that's a follow-up after the cascade is canary-validated.
- **VAD:** Silero VAD (already in `requirements.txt`). Same `vadSilenceMs` config knob as the Vertex side.
- **Audio formats:** PCM 16kHz mono out of STT, 24kHz mono back from TTS — LiveKit resamples both. ffmpeg is in the Docker image for providers that don't ship native resampling.
- **Interruption / barge-in:** `livekit-agents` `AgentSession` handles this natively — when the user starts speaking mid-response, the SFU's VAD signals an interrupt, the agent cancels in-flight TTS, the LLM's pending generation is aborted.

### 2.5 Context / prompt parity with Vertex

**The hard rule (from the decision-contract feedback memory):** the agent must receive the same `AssistantDecisionContext` the Vertex path renders into its system instruction. No raw context leakage. No duplicate Brain logic.

**Source of truth for the rendered prompt:** `/api/v1/orb/context-bootstrap` — already implemented in [`orb-livekit.ts`](../../services/gateway/src/routes/orb-livekit.ts) at the gateway. The endpoint takes an `orb_session_id`, runs the same gateway-side context assembly (memory broker, decision-contract spine, persona resolution, client context, anonymous vs authenticated branching), and returns:

```jsonc
{
  "ok": true,
  "system_instruction": "...",   // already-composed string
  "tools": [...],                 // tool catalog (per persona)
  "persona": "vitana" | "sage" | ...,
  "voice_id": "...",
  "lang": "en" | "de" | ...,
  "transcription_config": {...},
  "decision_context": {...},      // raw for inspection only; agent does NOT re-render
}
```

The agent's `bootstrap.py` calls this endpoint, hands `system_instruction` + `tools` to `livekit-agents` Agent constructor as-is. **No prompt assembly in the agent.** **No reading of memory / journey signals from inside the agent.** **No second `AssistantDecisionContext` path.**

**Hard guarantee:** flipping `voice.active_provider` between Vertex and LiveKit cannot change what the user sees in the rendered system instruction — both paths render through the same gateway-side compiler and renderer.

### 2.6 Tool parity

Vertex dispatches tools via `executeLiveApiTool(name, args, session)` inside `orb-live.ts`. The LiveKit agent must invoke the **same handler set** — not reimplement them — so the user experience is byte-identical.

**Pattern (already scaffolded in [`tools.py`](../../services/agents/orb-agent/src/orb_agent/tools.py)):**

```python
@function_tool
async def search_memory(context: RunContext, query: str, limit: int = 5) -> str:
    return await _dispatch(context, "search_memory", {"query": query, "limit": limit})
```

Each tool is a thin `@function_tool` wrapper that calls a gateway HTTP endpoint (`gateway_client.py`) carrying the user's JWT (minted alongside the room token — see `orb-livekit.ts` `mintAgentJWT`). The gateway endpoint shares the same handler used by the Vertex path:

```
LiveKit tool call  →  agent's @function_tool wrapper  →  HTTPS POST to gateway  →  same Vitana tool handler
                                                                                          ↑
                                                                                          |
Vertex tool call  →  executeLiveApiTool()  ---------------------------------------------- ┘
```

**Tools out of scope for L2.2b.1–b.3:**
- `send_chat_message`, `navigate`, `set_reminder`, `create_calendar_event`, etc. → land in L2.2b.4 once base voice loop is stable.
- Navigator directives (data-channel `orb_directive` per [`directives.py`](../../services/agents/orb-agent/src/orb_agent/directives.py)) → L2.2b.4 wires the data channel from agent to browser, mirroring the Vertex SSE/WS path byte-for-byte.

**Tool catalog source of truth:** the **gateway** owns it via `services/gateway/src/orb/live/tools/live-tool-catalog.ts`. The agent's `bootstrap.py` receives the per-persona tool list from `/orb/context-bootstrap` and uses it to register the right `@function_tool` subset for that session. **Never hardcoded in the agent.**

### 2.7 Telemetry

Already enumerated in `manifest.json#telemetry.oasis_events`:

```
livekit.session.start
livekit.session.stop
livekit.tool.executed
livekit.tool_loop_guard_activated
livekit.stall_detected
livekit.connection_failed
livekit.config_missing
livekit.fallback_used
livekit.provider_quota_exceeded
livekit.provider_failover
livekit.context.bootstrap
livekit.context.bootstrap.skipped
voice.handoff.start
voice.handoff.complete
voice.handoff.failed
agent.voice.persona_swap
```

L2.2b.1 must also add (per the L2 brief):
- `orb.upstream.livekit.connect_started` — agent received room job
- `orb.upstream.livekit.connect_succeeded` — agent + user both in room, first audio published
- `orb.upstream.livekit.connect_failed` — agent failed to join / dispatch / handshake
- `orb.upstream.livekit.first_audio` — first model audio chunk reached the user
- `orb.upstream.livekit.session_disconnect` — payload `{reason, room_session_duration_ms, peer_count_at_disconnect}`

All events carry: `tenant_id`, `user_id`, `orb_session_id`, `room_name`, `provider='livekit'`, `canary=true`, `vtid='VTID-02985'`. Emitted via `POST /api/v1/oasis/emit` (the agent's `oasis.py` already drafts this).

**Hard rule (from the feedback memory "no degraded flag in voice-tool responses"):** telemetry is server-side. The LLM never sees the OASIS payload; tool JSON responses match full-success shape.

### 2.8 Rollback

Three independent one-config knobs, any of which restores the pre-L2.2b path:

1. **`voice.livekit_agent_enabled = false`** (or unset, env: `ORB_LIVEKIT_AGENT_ENABLED=false`) → L2.2a resolver returns `pinned_until_agent_ready` for canary callers → frontend sees `active_provider: 'vertex'` on next `useActiveVoiceProvider` refresh → next session falls back to `useOrbVoiceClient` (Vertex).
2. **`voice.active_provider = vertex`** → resolver returns `default_vertex` for everyone → all callers on Vertex.
3. **Clear `voice.livekit_canary_allowlist`** → resolver returns `canary_not_allowlisted` → all callers on Vertex.

Cold-rollback (provider outage scenario): set `voice.livekit_agent_enabled = false` AND clear the allowlist. Existing sessions keep running until the user reloads; new sessions go to Vertex on next `/orb/active-provider` poll (re-fetched on visibility-resume per `useActiveVoiceProvider`).

**Hot-rollback inside a session:** not supported in L2.2b — a user mid-conversation on LiveKit stays on LiveKit until they disconnect. The flip becomes effective on **next session start**.

### 2.9 Frontend contract confirmation

**No frontend code change required for L2.2b.**

[`useLiveKitVoice.ts`](https://github.com/exafyltd/vitana-v1/blob/main/src/hooks/useLiveKitVoice.ts) already:
1. Calls `POST /api/v1/orb/livekit/token` for a room JWT.
2. Connects with `new Room().connect(url, token)`.
3. Publishes the local mic via `localParticipant.setMicrophoneEnabled(true)`.
4. Subscribes to remote audio tracks for playback.
5. Handles `RoomEvent.DataReceived` for directives (matches `directives.py`'s `orb_directive` topic).

[`useOrbVoiceUnified.ts`](https://github.com/exafyltd/vitana-v1/blob/main/src/hooks/useOrbVoiceUnified.ts) already pivots between Vertex and LiveKit based on `useActiveVoiceProvider()`. The L2.2a endpoint change is transparent — the existing hook reads the legacy `active_provider` field, which now carries the per-identity effective provider.

**One follow-up to validate (not a blocker):** the data-channel directive shape from the agent's `directives.py` must match the SSE directive shape `useOrbVoiceClient` already handles. The skeleton claims byte-identical; this needs a 30-min back-to-back diff in L2.2b.4 before declaring tool parity green.

### 2.10 Phased implementation

Each phase is its own VTID + PR. **No phase implements the next phase's behavior.** Vertex is the default + rollback in every phase.

#### L2.2b.1 — Minimal agent joins room, emits join/disconnect telemetry

Goal: prove the dispatch loop end-to-end. The agent connects, plays a chime via TTS to confirm it's alive, then sits silent waiting for further phases.

- Wire `agent_entrypoint` in [`session.py`](../../services/agents/orb-agent/src/orb_agent/session.py) to register a `JobRequest` filter on room-name prefix `orb-*`.
- Implement the new telemetry events from §2.7 (connect_started / connect_succeeded / connect_failed / first_audio / session_disconnect).
- Deploy the Cloud Run service via `gcloud run services replace service.yaml` (manual; EXEC-DEPLOY wiring is L2.2b.5).
- **DO NOT** flip `voice.livekit_agent_enabled` yet. Tests are agent-side smoke + LiveKit room-join verification using a test token from `/orb/livekit/token`. No real canary user touches it.
- **Acceptance:** create a test room → frontend joins → agent joins → both peers visible to LiveKit `RoomServiceClient` → agent emits all 5 connect events → both disconnect cleanly. No conversation. No tool calls. No Gemini.

#### L2.2b.2 — Bidirectional audio

Goal: audio flows in both directions, but no LLM yet. Agent echoes / plays a canned phrase to prove the pipeline.

- Hand `livekit-agents` an `AgentSession` with a STT plugin (Deepgram) wired in, a "passthrough" or echo-LLM (just emits the user's last STT chunk back to TTS), and a TTS plugin (Cartesia).
- The agent ignores tool capability entirely.
- Logs: STT segments + TTS chunks count, latency-to-first-audio, audio frames in/out per second.
- **DO NOT** flip the agent flag. Still test-room-only.
- **Acceptance:** user speaks "Hello", STT decodes, echo-LLM produces "You said Hello", TTS plays it back within < 2 s. Telemetry shows `first_audio` event firing.

#### L2.2b.3 — Full STT → Gemini → TTS pipeline with system_instruction parity

Goal: the agent runs a real conversation using the rendered system_instruction + tool descriptions from `/api/v1/orb/context-bootstrap`. No tool DISPATCH yet — the agent has the prompt+tool descriptions, but tool invocations fail loudly with "not_implemented" + an OASIS event.

- `bootstrap.py` calls `/orb/context-bootstrap`, passes `system_instruction` + persona + voice_id + lang to the AgentSession.
- LLM provider: Anthropic Sonnet 4.6 by default (per manifest provider_policy), tools registered as `@function_tool` stubs.
- Any tool call → wrapper returns `{"ok": false, "error": "tool_dispatch_not_yet_wired_l22b3"}` + `livekit.tool.dispatch_blocked_l22b3` OASIS event.
- **DO NOT** flip the agent flag.
- **Acceptance:** open a test room, ask a factual question that does NOT require a tool ("what is the Vitana Index?"), agent responds with the same definition the Vertex path gives. Two side-by-side `/orb/chat` runs (Vertex + manual agent room) produce semantically-equivalent answers.

#### L2.2b.4 — Tool dispatch parity + data-channel directives

Goal: every tool the Vertex path supports runs from the agent and produces the same gateway-side side effect.

- Each `@function_tool` body in `tools.py` calls the right gateway HTTPS endpoint with the user's JWT (re-validate the JWT mint inside the token route already attaches the right scopes).
- Tool catalog driven by `bootstrap.py` per-persona (only registers tools the persona is allowed to use).
- Data-channel directives wired per `directives.py` — the agent publishes `orb_directive` payloads byte-identical to the Vertex SSE shape; `useLiveKitVoice` already subscribes.
- Specialist handoff: `report_to_specialist` swaps LLM + TTS in-place inside the AgentSession (skeleton already drafts this).
- **DO NOT** flip the agent flag.
- **Acceptance:** for the top 5 tools by traffic (search_memory, send_chat_message, navigate, switch_persona, set_reminder), execute each via the agent in a test room and via Vertex in a normal session — the gateway-side effect (DB row, OASIS event, response payload) is byte-identical.

#### L2.2b.5 — Canary enablement (the actual flip)

Goal: flip `voice.livekit_agent_enabled = true` for the first internal user. The L2.2a resolver starts returning `effectiveProvider: 'livekit'` for that allowlisted identity. The frontend's `useActiveVoiceProvider` re-fetches and `useOrbVoiceUnified` swaps to `useLiveKitVoice` on next session.

- EXEC-DEPLOY integration for `vitana-orb-agent` (Cloud Run deploy through the canonical pipeline).
- Per-identity smoke: one operator account → flip canary allowlist + agent flag → ORB session → verify telemetry events fire in OASIS, audio is bidirectional, tool calls reach the gateway, persona swap works.
- Rollback drill: flip `voice.livekit_agent_enabled = false` mid-experiment → verify resolver flips back → next session uses Vertex.
- **NO broad rollout.** L2.2b.5 acceptance is "one canary user can have a full conversation on LiveKit with the same tool surface as Vertex." Broader rollout is its own scope.

---

## 3. What this design does NOT cover

- **Multi-tenant rollout policy** (rollout per-tenant, per-cohort, per-region). Out of scope until L2.2b.5 succeeds.
- **Cost/latency benchmarking** (LiveKit cascade vs Vertex Live for first-audio, p95 turn latency). The Improve cockpit's existing `quality-by-provider` strip is the measurement surface; data lands as L2.2b.5 emits events.
- **Realtime model path** (OpenAI Realtime, Gemini Live via LiveKit's realtime plugin). The provider policy in `manifest.json` reserves the slot; implementation is a separate VTID once the cascade is canary-validated.
- **Hot rollback inside a session** (mid-conversation Vertex flip). Not feasible without forced room disconnect + frontend reconnect; the current model is "rollback affects next session start."
- **Backend LiveKit-Cloud option** (vs self-hosted LiveKit OSS). The manifest already commits to self-hosted (`2x c2-standard-4 SFU pair + Memorystore Redis`). Changing that is a separate decision.

---

## 4. Open questions for review

1. **EXEC-DEPLOY wiring for `vitana-orb-agent`.** PR #8 referenced in `service.yaml` annotation may or may not have landed. If not, L2.2b.5 has a deploy-pipeline subtask attached to it. Confirm with `gh pr list --search "orb-agent EXEC-DEPLOY"`.
2. **Provider-secrets policy.** `service.yaml` references many `secretKeyRef` entries (Cartesia, Deepgram, Anthropic, etc.). Confirm Secret Manager already has these populated for the dev environment; if not, L2.2b.1 needs a pre-flight task to create them.
3. **Self-hosted LiveKit SFU readiness.** The manifest says "2x c2-standard-4 SFU pair + Memorystore Redis." Is this provisioned? If yes, what URL? If not, L2.2b.1 stalls until SFU is up.
4. **`/api/v1/oasis/emit` endpoint.** `oasis.py` references it. The gateway emits OASIS internally; if there's no public `emit` endpoint, the agent must use a different transport (gateway service token + internal route, or direct Supabase write). Confirm.
5. **Tool authentication.** Tools fire HTTPS to the gateway with a user JWT. Confirm the existing `mintAgentJWT` in `orb-livekit.ts` produces a token the gateway middleware accepts on the same endpoints `executeLiveApiTool` reaches today. There may be a scope mismatch.

These five questions block L2.2b.1 if any answer is "no" or "doesn't exist yet." None of them require code from this design doc.

---

## 5. Approval checklist

Approve this design before any L2.2b code is written. After approval:

- [ ] Allocate L2.2b.1 VTID. Implement minimal-join phase.
- [ ] Resolve open questions §4.1 – §4.5 before L2.2b.1 implementation begins.
- [ ] Stop at each phase boundary for explicit go-ahead before the next phase.
- [ ] Hard rule throughout: Vertex remains default; only the L2.2b.5 phase flips `voice.livekit_agent_enabled = true` and only for one canary identity.

---

*Authored under VTID-02985 (design-only). Inherits architectural decisions from VTID-LIVEKIT-FOUNDATION (the orb-agent skeleton).*
