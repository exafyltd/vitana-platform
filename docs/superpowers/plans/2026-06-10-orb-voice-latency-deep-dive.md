# ORB Voice-to-Voice Latency Deep Dive — Root Causes & Fix Plan

**Date:** 2026-06-10
**Scope:** `exafyltd/vitana-platform` (gateway, orb-widget.js, Vertex Live path) + `exafyltd/vitana-v1` (OrbVoiceClient/TalkToVitana path)
**Symptom:** 7–10 s to start a session or receive an answer. Market baseline: <1 s simple turn, ~1.5 s with retrieval.
**Target:** <3 s perceived, both session start and per-turn.

---

## 1. Executive summary

The 7–10 s is not one bug. It is the SUM of (a) ~2.85 s of **deliberate dead-air gates** added per turn to fight echo, (b) a **request-per-chunk HTTP transport** that forced the gateway to be pinned to a single Cloud Run instance, (c) **blocking tool calls** with 3–16 s budgets that silence the model mid-turn, and (d) a **serial session-start chain** (context bootstrap → Vertex WS handshake → SSE attach → audio-ready handshake → live TTS greeting).

The good news: roughly **half of the per-turn latency is pure configuration** (DB-backed policy keys, no deploy needed), and the platform already contains the faster building blocks (a full WebSocket transport in `orb-live.ts`, a bootstrap cache, a LiveKit/WebRTC canary, a latency tracker).

### Where a typical answer's 7–10 s goes (per turn)

| Stage | Cost | Class |
|---|---|---|
| Server post-turn cooldown — **user audio dropped** | **2 000 ms** | config (policy key) |
| Client post-turn + echo cooldowns (500 + 500 ms) | up to 1 000 ms | config (widget) |
| Mic fully muted while model audio plays (no real barge-in) | variable | design |
| Audio upstream jitter (HTTP POST per 64 ms chunk) | 100–300 ms | architecture |
| Gemini VAD end-of-speech silence wait | **850 ms** | config (policy key) |
| Tool call(s) — model is mute until `function_response` | 300 ms – 6 s+ | architecture |
| Model inference + first audio token | 700–1 500 ms | provider |
| SSE delivery + client playback buffer (4 096 B ≈ 85 ms) | 150–300 ms | minor |
| Turn-complete bookkeeping partially on hot path | 100–460 ms | code |

No-tool turn: **~4–5 s perceived**. One memory/knowledge tool: **5–7 s**. Tool chain or a 3 s tool timeout: **7–10 s+**. This matches the reported numbers exactly.

---

## 2. Root causes, ranked by impact

### RC-1 — ~2.85 s of intentional per-turn dead air (HIGHEST, cheapest to fix)

The user physically cannot be heard for ~2 s after every model turn, then Gemini waits another 0.85 s of silence before deciding the user finished.

* **Server drops mic audio for 2 s after every `turn_complete`:**
  `services/gateway/src/orb/upstream/constants.ts:51` — `POST_TURN_COOLDOWN_MS_FALLBACK = 2_000`, enforced at
  `services/gateway/src/orb/live/session/live-session-controller.ts:1848-1851` (SSE path, returns `dropped: true, reason: 'post_turn_cooldown'`) and
  `services/gateway/src/routes/orb-live.ts:13361` (WS path).
  Anything the user says in that window is silently discarded → Gemini receives truncated speech → mis-segmented turns → user repeats themselves → "it takes forever to answer".
* **Client adds two more 500 ms gates:** `services/gateway/src/frontend/command-hub/orb-widget.js:2079` (post-turn) and `:2085` (after last audio actually ends).
* **Mic is hard-muted during model playback** (`orb-widget.js:2067` — `return; // Don't send audio while model speaking`). Barge-in only fires after ~384 ms of sustained loud speech (`:2024-2028`); there is no full-duplex audio.
* **VAD end-of-speech = 850 ms** before Gemini starts thinking: seed `supabase/migrations/20260528000000_VTID_03124_voice_thresholds_seeds.sql:17` (`voice.vad.silence_duration_ms = 850`), widget sends 850 (`orb-widget.js:1195`), applied at `orb-live.ts:6128-6131`.

All four values are tunable **without a redeploy** — `voice.post_turn.cooldown_ms` and `voice.vad.silence_duration_ms` are DB-backed policy keys (`services/gateway/src/services/decision-contract/policy-keys.ts:39-40`).

### RC-2 — Transport: one HTTP POST per 64 ms of audio + single-instance pin

* Mic capture uses a deprecated main-thread `ScriptProcessor(1024)` at 16 kHz (`orb-widget.js:2018`) → a chunk every **64 ms** → `_sendAudio()` fires a **separate `fetch` POST** with base64-in-JSON per chunk (`orb-widget.js:2103-2137`). That is ~15.6 requests/second/user, each with headers, auth, JSON parse, base64 decode on the gateway.
* Downstream is SSE (`orb-widget.js:1324-1327`); upstream HTTP; ordering and pacing are not guaranteed → jittery audio into Gemini → its VAD waits longer to call end-of-turn.
* Because `liveSessions` is an **in-memory per-instance Map**, round-robined POSTs hit the wrong instance (404 → silent session re-register storm, `orb-widget.js:2115-2123`). The "fix" was pinning the gateway to **`--max-instances=1`** (`.github/workflows/EXEC-DEPLOY.yml:546-549`, comment says it's a temporary brake). One instance now serves the ENTIRE platform — every voice chunk POST, every API route, Command Hub, crons. Under any concurrent load this single CPU saturates and tail latency explodes into the seconds.
* Ironically a **complete WebSocket transport already exists** in the gateway (`orb-live.ts` `handleWs*` path, ~13 000+ lines incl. WS session start, audio, reconnect) — the production widget just doesn't use it.

### RC-3 — Blocking tool calls silence the model for 3–16 s

* When Gemini calls a tool, it cannot speak until the gateway returns `function_response`. Tool budgets: **16 s** `consult_external_ai`, **12 s** autopilot tools, **3 s** everything else (`orb-live.ts:2195-2198`).
* `search_memory` ≈ 300–800 ms (pgvector + re-rank), `search_knowledge` ≈ 200–500 ms (router + context pack), `navigate` ≈ 300–700 ms. No result caching. Tool *chains* (memory → knowledge → navigate) run serially; a single timeout adds a flat 3 s of silence before the model re-plans.
* No use of Gemini Live's async/NON_BLOCKING function-calling mode, no "let me check that" filler turn — the user hears dead air.

### RC-4 — Session start: serial chain ending in live TTS

Path (widget): tap → `POST /api/v1/orb/live/session/start` (8 s client abort budget, `orb-widget.js:1261`) → gateway runs context bootstrap (6 parallel Supabase queries, 400–800 ms uncached; 5–32 KB system instruction; `orb/live/session/live-session-controller.ts:750-873`, `orb-live.ts:2051-2142`) → Vertex WS connect + `setup`/`setup_complete` round-trip (250–600 ms) → HTTP response → widget attaches SSE → **audio-ready handshake** (greeting deferred until client POSTs `/audio-ready`, 2 s fallback timer — `orb-live.ts:13270-13274`, `orb-widget.js:907-935`) → Gemini *generates* the greeting live (1–2 s TTS) → first audio.
Best case ~3 s; cache miss / slow network / first widget load (deferred script + 500 ms polling loop in `vitana-v1/src/hooks/useOrbVoiceWidget.ts:354-362`) lands at 7–10 s.
Mitigations that already exist: in-memory bootstrap cache 60 s TTL (VTID-03035), shared `bootstrap_cache` table (VTID-03036), pre-warm on token mint. The 60 s TTL means most real sessions still miss.

### RC-5 — Turn-complete bookkeeping partially on the hot path

`orb/live/session/upstream-message-handler.ts:241-690`: user-transcript write (`writeMemoryItemWithIdentity` + `addSessionTurn` + Redis dual-write) and assistant-transcript write run inside the turn-complete handler (~110–460 ms of Supabase/Redis round-trips). Several others are correctly fire-and-forget (wake-cadence, identity intent, chat bridge, OASIS events).

### RC-6 — Smaller frictions

* Playback waits for 4 096-byte chunks (~85 ms) — `vitana-v1/src/utils/vertexAudio.ts:269`.
* `vitana-v1` auth probe `GET /auth/me` (5 s timeout) on widget init blocks readiness (`useOrbVoiceWidget.ts:56-68`).
* Gateway deploy sets no `--cpu/--memory` for prod (Cloud Run defaults) while pinned to one instance.
* ORB LiveKit agent has `--min-instances=1` only when active (`DEPLOY-ORB-AGENT.yml:127`); cold start = 5–8 s on the canary path.

---

## 3. Fix plan to reach <3 s

### Phase 0 — Measure first (same day)
The latency tracker (`orb/live/latency-tracker.ts`) and wake-timeline events already exist. Add one structured log per turn: `user_speech_end → vad_fired → inference_start → tool_ms → first_audio_chunk → client_play`. Without this, every later phase is guesswork.

### Phase 1 — Policy/config only, no deploy (1 day, saves ~2.5–3 s/turn)
| Change | From → To | Where |
|---|---|---|
| `voice.post_turn.cooldown_ms` | 2000 → **250–300** | DB policy key (rely on browser AEC + client-side echo gate) |
| `voice.vad.silence_duration_ms` | 850 → **500–600** | DB policy key + `orb-widget.js:1195` |
| Widget post-turn + echo cooldowns | 500/500 → **200/200** | `orb-widget.js:2079,2085` |
| Bootstrap cache TTL | 60 s → **10–15 min** (invalidate on profile/memory write) | VTID-03035/03036 |
| Greeting audio-ready fallback | 2000 → 1000 ms | `orb-live.ts:13272` |

### Phase 2 — Hot-path code (≈1 week, saves 1–3 s/turn and 1–2 s at start)
1. **Tools:** default budget 3 s → 1.5 s; cache `search_memory`/`search_knowledge` per (user, normalized query) for the session; pre-fetch the likely memory pack at turn-start in parallel with inference; enable Gemini Live **async function calling (NON_BLOCKING)** or send an immediate interim `function_response` ("checking…") so the model speaks while the tool runs.
2. **Turn-complete:** make BOTH transcript persists fully fire-and-forget (queue + retry), nothing awaited between `turn_complete` and the next user turn.
3. **Session start:** pre-create the Live session (or at least run context bootstrap + mint) on app load / orb hover, not on tap; keep the widget script `async` + preloaded (`vitana-v1/index.html:55`); cut the 500 ms readiness poll to 100 ms.
4. **Greeting:** for returning users serve a cached/pre-synthesized one-liner instantly, let the personalized opener follow.

### Phase 3 — Transport & scaling (1–2 weeks, removes the systemic ceiling)
1. **Switch the widget to the existing WebSocket path** (binary frames, no base64-JSON-per-64 ms, ordered, one connection). The server side is already written and maintained in `orb-live.ts`.
2. **Move `liveSessions` to a shared store** (Redis/Supabase as VTID-02037's comment already plans) or use WS-native instance affinity → **lift `--max-instances=1`**, set gateway to 2 vCPU / concurrency tuned, min-instances ≥ 2. This single change protects every other latency win under load.
3. Replace `ScriptProcessor` with an `AudioWorklet`; halve the playback buffer to 2 048 B.
4. Longer term: promote the **LiveKit/WebRTC path** (already a canary, `orb-livekit.ts` + agent) for true sub-second full-duplex with built-in barge-in, and keep its agent at min-instances ≥ 1.

### Expected end state per turn
500 ms VAD + ~700–1200 ms inference/first-audio + ~150 ms delivery ≈ **1.4–1.9 s** (no tool), **~2.5 s** with one cached tool. Session start ≈ **2–3 s** warm. Both under the 3 s target.

---

## 4. Verification

After each phase, replay the same scripted conversation (login → orb open → "what's my name?" → knowledge question → navigation ask) on `preview-gateway.vitanaland.com` and compare the Phase-0 per-stage timeline. Acceptance = p50 turn <2 s, p95 <3 s, session start p95 <3 s.
