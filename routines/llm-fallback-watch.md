# Routine: llm-fallback-watch

**Schedule:** `15 7 * * *` (daily 07:15 UTC)
**Runs in:** the gateway's routine runner (`services/gateway/src/services/routine-runner`, VTID-05141), once per UTC day at the time above. It records the run in `routine_runs` (`trigger = gateway-runner`) and on a breach emits the event below and hands it to the self-healing intake.

**Catalog row:** `routines.name = 'llm-fallback-watch'`
**OASIS VTID for emitted events:** `VTID-05141`
**Loop:** L5 Guard (case G05, silent model-fallback detector)

## Autonomy contract

Claude runs on Bedrock; no LLM-routing stage may land on Google, and a fallback that lands on Google is an incident, never normal operation (CLAUDE.md rules 10a–10c, IF-THEN 27 and 29). This routine reads the last 24 h of `llm.call.completed` events and classifies each with `isGoogleLlmCall` (`services/gateway/src/services/ops-attention-adapters.ts`: provider vertex/google/gemini, or a model starting with `gemini`) — the same predicate the Ops Attention Google-fallback item uses.

The sanctioned Google uses (the sr/ru Vertex voice bridges, audiobook Google TTS) are not LLM-router calls and do not appear in `llm.call.completed`.

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | No LLM call landed on Google in 24 h. |
| 🟡 `partial` | One or more did → incident event emitted (status `error`), self-healing notified. |
| 🔴 `failure` | The read failed. |

## On a breach — OASIS event

```
type: llm.fallback.google_incident   vtid: VTID-05141
source: routine.llm-fallback-watch   status: error
payload: { google_calls_24h, fallback_to_google, routed_at_google, fallback_stages, routed_stages, models }
```
