# VTID-04587 — ORB shows Thinking, not Listening, when the user answers during playback

Reported by the platform owner on staging: when Vitana has to think, the orb
switches to Listening (mic opens, ready beep) and 1–3 s later back to
Vitana speaking.

## Root cause

The server finishes a turn before the browser finishes playing it (Nova
audio arrives faster than real time). When the user answers during that
playback tail, the server's `thinking` signal reaches the widget while its
state is still `SPEAKING`, and the widget's `thinking` handler only acted in
`LISTENING`/`IDLE` — the signal was dropped. When playback ended, the
turn_complete drain poll (and the 2 s speaking-state watchdog) switched to
Listening, with the ready beep, while Vitana was preparing her answer; the
answer audio then flipped it back to Speaking.

## Acceptance criteria

AC-1: A `thinking` signal that arrives while Speaking is remembered, and the end of playback shows Thinking (no ready beep) instead of Listening.
TEST: services/gateway/test/frontend/vtid-04587-thinking-after-playback.test.ts

AC-2: The normal Listening transitions are unchanged: after a reply with no user input, after a silent turn, and the existing LISTENING/IDLE/MUTED thinking paths.
TEST: services/gateway/test/frontend/vtid-04587-thinking-after-playback.test.ts

AC-3: Answer audio and the next turn_complete clear the remembered signal; disconnect and session stop clear it; a 15 s fallback returns to Listening if no answer arrives.
TEST: services/gateway/test/frontend/vtid-04587-thinking-after-playback.test.ts

AC-4: Verified in a real browser on the real widget: 7 scenarios, before/after, desktop and mobile screenshots (`outputs/`). The old widget fails exactly the two bug scenarios; the four normal scenarios produce identical sequences before and after.
TEST: services/gateway/test/frontend/vtid-04587-thinking-after-playback.test.ts

## Browser verification (scripts/orb/verify-thinking-display.mjs)

| Scenario | Before (main) | After |
|---|---|---|
| answer during playback tail (with tool) | speaking → **listening** → speaking | speaking → **thinking** → speaking |
| answer during tail (no tool) | speaking → **listening** → speaking | speaking → **thinking** → speaking |
| greeting then silence | listening | listening |
| question after reply finished | listening → thinking → speaking | same |
| barge-in | listening → thinking → speaking | same |
| silent turn after tail input | listening | listening |
| no answer ever arrives | listening | thinking → listening after 15 s |

## Cache bust

The gateway serves `/command-hub/*.js` with a one-year immutable cache, so
the fix reaches browsers only when the `?v=` query changes:
`command-hub/index.html` here, and `index.html` in `exafyltd/vitana-v1`
(companion PR) — both `?v=20260925-vtid-04587-thinking`.
