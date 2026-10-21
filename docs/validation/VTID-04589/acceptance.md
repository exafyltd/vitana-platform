# VTID-04589 — wake-brief first utterance stated positively

## Problem (measured on staging, 2026-09-25)
Nova content-filter blocks, staging Nova sessions: 0/120 earlier today, then
2/15 after 20:01 UTC. Both blocked sessions opened with the
`wake_brief_override` login briefing, whose setup carries the block
"SPOKEN FIRST UTTERANCE — REQUIRED VERBATIM": "MUST be EXACTLY this text.
Copy these characters letter-for-letter; do not paraphrase, do not translate,
do not shorten …" plus four "Do NOT" rules. Neither retry without that block
was blocked. The code comment already recorded that non-guided sessions with
this block "succeed ~50% of the time".

## Controlled replay (real Nova 2 Sonic, gateway's own NovaSonicLiveClient)
Input: the exact setup instruction of blocked staging session
live-40e5aea4 (40,389 chars) plus the real greeting turn (reconnect bucket).
Five runs per variant:

| Variant | Result |
|---|---|
| A: exact blocked setup | 5/5 blocked |
| B: A without `<social_context>` | 5/5 blocked |
| C: A without the REQUIRED VERBATIM block | 5/5 spoke |
| D: A with the same quoted line stated positively (this change) | 5/5 spoke |

B rules out VTID-04577's larger member context as the cause. D shows that the
line itself is fine and the prohibition stack around it is what gets blocked.

## Change
`buildVertexWakeBriefBlock` (non-guided branch): same override marker, which
still suppresses the short-gap greeting pool. The same quoted line is spoken
as written, in one turn. Every rule is kept, stated positively. The dedupe
note reads "(spoken once, this turn only)". The guided branch (VTID-03797) is
unchanged apart from that shared dedupe note.

## Acceptance criteria
AC-1: The non-guided block delivers the quoted line behind the override marker and suppresses the short-gap pool.
TEST: services/gateway/test/orb/live/session/guided-topic-spoken-first-utterance.test.ts — "delivers the quoted line as written, behind the override marker"

AC-2: The block carries no prohibition stack (no REQUIRED VERBATIM, letter-for-letter, do not paraphrase/translate/shorten, NOT).
TEST: services/gateway/test/orb/live/session/guided-topic-spoken-first-utterance.test.ts — "carries no prohibition stack"

AC-3: The voice payload changes only by this block; tools are unchanged.
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts (snapshots regenerated on purpose; instruction −393 bytes)

AC-4: On staging, login-briefing sessions are no longer blocked by the content filter.
UI: staging oasis_events — orb.live.diag upstream_error failure_kind=content_filter for sessions whose brain_context_built keeps wake_brief_override, after deploy
