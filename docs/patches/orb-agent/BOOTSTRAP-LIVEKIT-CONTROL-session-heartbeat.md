# BOOTSTRAP-LIVEKIT-CONTROL — agent-side spec: keep continuity `last_turn_at` fresh

**Status:** SPEC ONLY. `session.py` is outside the gateway sandbox; this file
documents the (optional) agent-side change that makes the new gateway control-
plane signal accurate. No agent code is changed by this PR.

## Why

The gateway now exposes a read-only LiveKit session-health summary:

```
GET /api/v1/orb/livekit/sessions/health   (exafy_admin only)
```

It classifies `orb_session_state` `continuity` rows as **active / expired /
stuck**. "Stuck" = an active row (TTL not yet elapsed) whose newest activity
timestamp (`value.last_turn_at` → `value.last_greeting_at` → `updated_at`) is
older than a staleness threshold (default 10 min). That flags rooms a client
never closed cleanly.

The stuck signal is only as good as the freshness of `last_turn_at` in the
continuity blob. Today continuity is persisted on close/reopen (ORB-2+3). If a
client crashes mid-session, the last persisted `last_turn_at` may be stale even
though the room is genuinely active — producing a false-positive "stuck".

## Proposed agent-side change (optional, additive)

In the orb-agent session loop (`services/agents/orb-agent/session.py`), after
each completed user turn, refresh the continuity row's `last_turn_at` via the
existing gateway continuity write path (do NOT write Supabase directly from the
agent — gateway owns DB mutations). Concretely:

- On `on_user_turn_committed` (or equivalent), debounce to at most one write
  per ~30s and POST the existing continuity-persist endpoint with an updated
  `last_turn_at = now()` and the current `conversation_id`.
- Reuse the per-session `user_jwt` from room metadata as Bearer (same pattern
  already used for tool calls).

This is purely an accuracy improvement for the control-plane signal. The
gateway endpoint already degrades gracefully (treats unknown-activity rows as
suspect and sorts them first), so the dashboard is useful even without this.

## Non-goals

- Do NOT alter the double-greeting / first-turn logic (separate, merged work).
- Do NOT add an agent→Supabase direct write.
- No change to the voice hot path latency budget — the heartbeat write is
  fire-and-forget and debounced.
