# orb-agent

LiveKit-based ORB voice agent worker.

## What this service is

A Python `livekit-agents` worker that joins LiveKit rooms as a participant, runs a configurable STT → LLM → TTS cascade, dispatches the same ~40 tools the Vertex Live pipeline exposes, and emits OASIS events with the same semantics. It is the **standby alternative** to the Vertex Live pipeline at `services/gateway/src/routes/orb-live.ts`.

The two pipelines are **mutually exclusive** at runtime — exactly one is active at any moment, controlled by `system_config.voice.active_provider` ∈ `{vertex, livekit}`. With LiveKit promoted to a primary path, Cloud Run keeps one warm worker (`min_instances=1`) so the first room join doesn't hit cold-start latency (~1-2s) for real users. See VTID-03016.

See `.claude/plans/here-is-what-our-valiant-stearns.md` for the full architecture rationale.

## Status

**Skeleton.** Module shape established, key entrypoints stubbed, imports compile. **Does not run a real conversation yet.** Subsequent PRs land:

1. Real `instructions.py` system-instruction builder ported from `buildLiveSystemInstruction()` in `orb-live.ts`.
2. Real `tools.py` — every tool from `voice-pipeline-spec/spec.json` as a `@function_tool` HTTP wrapper to its existing gateway endpoint.
3. Real `providers.py` factory that loads STT/LLM/TTS plugins from `agent_voice_configs`.
4. Real `bootstrap.py` calling `GET /api/v1/orb/context-bootstrap`.
5. Real `oasis.py` POSTing to `POST /api/v1/oasis/emit`.
6. Real `session.py` lifecycle including the multi-specialist handoff path.

## Module layout

```
services/agents/orb-agent/
  main.py                  — entrypoint: starts livekit-agents worker + health server
  src/orb_agent/
    __init__.py
    config.py              — env vars + LiveKit config resolution
    session.py             — agent session lifecycle + handoff path
    instructions.py        — buildLive / buildAnonymous system-instruction builders
    tools.py               — @function_tool wrappers (one per spec.json tool)
    providers.py           — STT/LLM/TTS plugin factory from agent_voice_configs
    bootstrap.py           — context-bootstrap fetcher (memory + role + last session + admin briefing)
    oasis.py               — OASIS event emitter (POSTs to gateway)
    watchdogs.py           — stall watchdog + reconnect bucket counter
    identity.py            — JWT identity resolution + mobile=community coercion
    navigator.py           — get_current_screen / navigate tool helpers
    video.py               — video frame forwarder for vision-capable LLMs
    health.py              — embedded FastAPI health-check server (Cloud Run probe)
    registry_client.py     — agents_registry self-register heartbeat
  tests/                   — unit tests (pytest)
```

## Running locally

Two-step. First the gateway must be reachable (it owns context-bootstrap, OASIS-emit, tool endpoints, the LiveKit token mint). Then the agent connects to a self-hosted LiveKit Server.

```bash
cd services/agents/orb-agent

# 1. Install (with extra providers)
pip install -e ".[dev,extra-providers]"

# 2. Configure
export LIVEKIT_URL=wss://livekit.your-domain.dev
export LIVEKIT_API_KEY=...
export LIVEKIT_API_SECRET=...
export GATEWAY_URL=https://gateway-q74ibpv6ia-uc.a.run.app
export GATEWAY_SERVICE_TOKEN=...

# 3. Run
python main.py
# health: http://localhost:8080/health
# the worker connects outbound to LIVEKIT_URL and waits for room dispatch
```

## How it relates to the parity scanner

`voice-pipeline-spec/tools/extract-py.py` (the libcst walker) statically extracts:
- every `@function_tool`-decorated function in this folder → tool list
- every `oasis.emit(topic=...)` call site → OASIS topics
- every `*_MS` / `MAX_*` / `*_TIMEOUT` constant → watchdog values
- the parameter signatures of `build_live_system_instruction` / `build_anonymous_system_instruction`

Then `voice-pipeline-spec/tools/diff.ts` three-way-diffs against `spec.json` and the Vertex extraction. If a new tool appears in `orb-live.ts` but not here (or vice versa), the parity scanner CI flags it on the offending PR. After 30 days of green runs, the scanner promotes from report-only to a hard merge gate for safety-critical drift.

This is why the skeleton matters: it gives the Python extractor real symbols to find, even before any tool body is implemented. Empty `@function_tool` stubs that match the spec are the foundation.

## Deployment

Cloud Run service `vitana-orb-agent` in `us-central1`, `min-instances=1`, `max-instances=10`. EXEC-DEPLOY workflow gates on the `/health` probe responding 200 with `{"livekit_reachable": true, "providers": {...}}`.

One warm worker is kept hot so the click→greeting path doesn't pay Cloud Run cold-start (~1-2s) on first room join (VTID-03016). The standing cost is one always-on `cpu=2 / memory=4Gi` instance — accepted as the price of acceptable voice latency. The LiveKit SFU pair (separate workload) and the Artifact Registry image (~$0.20/mo) are additional.

## Memory anchors

- Plan: `.claude/plans/here-is-what-our-valiant-stearns.md`
- Spec: `voice-pipeline-spec/spec.json`
- Vertex sibling: `services/gateway/src/routes/orb-live.ts`
- Parallel team: `memory/project_unified_feedback_pipeline.md` — owns the specialist handoff path on the Vertex side
- Mobile rule: `memory/feedback_mobile_community_only.md`
- Apology-loop fix: `memory/orb_apology_loop_fix_VTID_02637.md`
