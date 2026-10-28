# BOOTSTRAP-VOICE-DATASET-EMITTER — LiveKit (orb-agent) parity patch

**Status:** Patch spec (session.py is out of the gateway sandbox — apply in the
`orb-agent` deploy).

## Why

The Phase-1 voice-tool-routing dataset extractor
(`services/gateway/scripts/datasets/voice-tool-routing.ts`) reads from
`oasis_events` where `topic = orb.turn.responded` and projects the tool-routing
signal off the event `metadata` column:

```ts
const toolName  = meta.tool_name ?? meta.tool_call?.name;
const userInput = meta.transcript ?? meta.input_text;
tool_arguments  = meta.tool_call?.arguments ?? null;
// PII gate (lib.ts): topic NOT LIKE 'safety.guardrail.%' AND metadata->>data_export_ok = true
```

The Vertex path (`orb-live.ts`) is now fixed: `emitOrbTurnResponded` emits these
exact fields, consent-gated (`buildOrbTurnRespondedPayload`).

**The LiveKit agent (`session.py`) does not emit `orb.turn.responded` at all** —
it only emits `vtid.live.session.start/stop`, `vtid.live.stall_detected`,
`livekit.tool.executed`, and the latency events. So LiveKit voice turns
contribute ZERO rows to the dataset. This patch closes that gap with the same
field shape + consent gate as the Vertex emitter, so the two providers reach
extractor parity.

## Field contract (must match the Vertex emitter exactly)

Top-level keys on the emitted event `payload` (the gateway maps the whole
payload into `oasis_events.metadata`):

| field | when | source |
|-------|------|--------|
| `orb_session_id`, `conversation_id`, `reply_length`, `reply_preview`, `provider`, `metadata:{mode:'orb_voice'}` | always | envelope (non-PII) |
| `data_export_ok: true` | consent established | tenant policy |
| `tool_name`, `tool_dispatched: true` | consent ✓ AND not guardrail AND a tool was chosen | last tool call |
| `tool_call: { name, arguments? }` | same | last tool call |
| `transcript`, `input_text` | consent ✓ AND not guardrail | raw user STT for the turn |

**PII rule:** `transcript` / `input_text` / tool fields are attached **only**
when (a) export consent is established for the tenant AND (b) the turn is not
under a `safety.guardrail.*` exclusion. Otherwise emit the envelope only.

## Patch for `services/agents/orb-agent/src/orb_agent/session.py`

### 1. Add the topic constant (oasis.py)

```python
# services/agents/orb-agent/src/orb_agent/oasis.py — alongside TOPIC_TOOL_EXECUTED
TOPIC_TURN_RESPONDED = "orb.turn.responded"  # voice-tool-routing dataset source
```

### 2. Resolve export consent agent-side (fail-closed, cached)

Mirror `services/gateway/src/services/data-export-consent.ts`: read
`tenant_settings.feature_flags.data_export_ok` for the session tenant. Strictly
`True` ⇒ consented; missing row / flag / error ⇒ not consented. Cache 5 min.

```python
async def _export_consent_ok(gw, tenant_id: str | None) -> bool:
    if not tenant_id:
        return False
    # GET tenant_settings?tenant_id=eq.{tenant_id}&select=feature_flags
    # return flags.get("data_export_ok") is True; any error -> False
    ...
```

### 3. Track the dispatched tool per turn

In the `@function_tool` dispatch path (where `livekit.tool.executed` is already
emitted), record the chosen tool + args on the turn state:

```python
turn_state["tool_name"] = tool_name
turn_state["tool_arguments"] = tool_args or None  # dict
```

Capture the user STT text already available in `_on_user_transcribed`
(`turn_state["user_text"] = t` — the same `transcript`/`text` field it reads for
`user_text_len`).

### 4. Emit `orb.turn.responded` on agent reply completion

Hook the agent-speech-finished event (the `speech_created` / agent_state→idle
transition that closes the turn). Build the payload with the consent gate:

```python
async def _emit_turn_responded(reply_text: str) -> None:
    consented = await _export_consent_ok(gw, identity.tenant_id)
    guardrail = bool(turn_state.get("guardrail_excluded"))
    payload: dict[str, Any] = {
        "orb_session_id": orb_session_id,
        "conversation_id": turn_state.get("conversation_id") or orb_session_id,
        "reply_length": len(reply_text),
        "reply_preview": reply_text[:140],
        "provider": "livekit",
        "metadata": {"mode": "orb_voice"},
    }
    if consented:
        payload["data_export_ok"] = True
    if consented and not guardrail:
        user_input = turn_state.get("user_text") or ""
        tool_name = turn_state.get("tool_name")
        if tool_name:
            payload["tool_name"] = tool_name
            payload["tool_dispatched"] = True
            tc: dict[str, Any] = {"name": tool_name}
            if turn_state.get("tool_arguments"):
                tc["arguments"] = turn_state["tool_arguments"]
            payload["tool_call"] = tc
        if user_input:
            payload["transcript"] = user_input
            payload["input_text"] = user_input
    if reply_text:
        await oasis.emit(topic=TOPIC_TURN_RESPONDED, payload=payload)
    # clear per-turn signal so it doesn't leak into the next turn
    turn_state.pop("tool_name", None)
    turn_state.pop("tool_arguments", None)
    turn_state.pop("user_text", None)
```

Skip the greeting turn (no user input), same as the Vertex path.

## Verification

After deploy, a consented LiveKit voice turn that dispatches a tool should land
an `orb.turn.responded` event whose `metadata` carries `tool_name`,
`tool_call`, `transcript`, `input_text`, and `data_export_ok=true`. Run the
preview:

```bash
DATASET_DRY_RUN=1 npx tsx services/gateway/scripts/datasets/voice-tool-routing.ts
```

Expect `rows_after_dedup > 0` once consented rows exist from either provider.
A non-consented turn must show the envelope only (no `transcript` / `tool_name`)
and be filtered out by the SQL PII gate.
