# VTID-03245 — LiveKit parity: tool-failure grace (offer-integrity)

**Status:** patch (orb-agent runs as a separate Cloud Run service / repo; cannot be deployed from the gateway sandbox).

## Why
The gateway fix (VTID-03245) makes the **Vertex** path never surface a hard tool failure to the model as a spoken "we have issues with the system" — it reshapes `success:false` results into a graceful pivot at the function-response boundary (`orb/live/session/upstream-message-handler.ts` → `graceToolResultForModel`).

For **LiveKit parity**, the orb-agent must apply the *same* reshape, because it calls the tool over HTTP and forwards the result to its own model:

- The agent calls `POST /api/v1/orb/tool` (handler: `services/gateway/src/routes/orb-tool.ts`).
- On failure that endpoint returns `{ ok: false, error: "...", vtid }`.
- The agent must NOT forward that error to its LLM as a tool/function response — it must forward a graceful-pivot result instead.

## Change (orb-agent, where it builds the function-response from the `/orb/tool` reply)

```python
# Mirror gateway graceToolResultForModel (VTID-03245).
def grace_tool_result_for_model(tool_name: str, reply: dict) -> dict:
    # reply is the JSON body from POST /api/v1/orb/tool
    if reply.get("ok") is not False:
        return reply  # success — forward unchanged
    return {
        "ok": True,  # the model must NOT see a failure shape
        "result": {
            "ok": False,
            "available": False,
            "tool": tool_name,
            "speak_guidance": (
                "This could not be completed right now. In ONE short, warm "
                "sentence, briefly acknowledge it and offer a DIFFERENT concrete "
                "thing you can actually do for the user (only use capabilities you "
                "have a tool for). Do NOT mention any error, bug, system problem, "
                "\"issues\", \"technical\", or that something failed — just pivot "
                "naturally and keep helping."
            ),
        },
    }
```

Apply it where the agent turns the `/orb/tool` HTTP reply into the function/tool response it sends to the model.

## Acceptance
- LiveKit: call a tool that fails (e.g. `create_index_improvement_plan` when the index isn't set up). The agent must speak a graceful pivot, never "we have issues with the system."
- Parity check: same failing tool produces structurally-equivalent graceful behavior on Vertex and LiveKit.

## Note (shared, already in gateway — both transports benefit)
`summarizeAutopilotForVoice` (empty case) was also changed to pivot instead of dead-ending on "no recommendations" — that is in `autopilot-recommendations.ts` and is shared by both transports, so no agent change is needed for the autopilot-empty path.
