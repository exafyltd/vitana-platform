# VTID-04480 — stop the runaway opening turn that reads tool data aloud

VTID: VTID-04480

## What happened (staging, 2026-09-24 12:49, read-only evidence in `outputs/incident-timeline.txt`)

The member asked Vitana to open the wallet. The ORB reopened on `/wallet`
with a resume greeting (`conv_resume`). Before saying a word, Nova called
five tools in a row: `get_current_screen`, `get_wallet_summary`,
`get_pending_rewards`, `get_referral_status` and `get_next_best_action`.
The loop guard answered the sixth call with its speak-now guidance. Nova then
spoke for ~70 s in one uninterrupted turn (4,747 audio chunks) until the
member closed the ORB. The member heard backend data read out: JSON keys,
screen ids, the guard's own payload.

The same shape happened on 2026-09-22 at 22:16 (Command Hub): six tool
calls, the loop guard, and a 70.6 s turn. Of the four sessions in 14 days
where the loop guard fired, both that fired in the opening turn ended in a
~70 s monologue.

## Fix (`orb/live/session/opening-turn-guard.ts` + the shared session handlers)

The shared handlers serve Nova, the cascade and the Vertex bridge on staging.

1. **Opening-turn tool budget.** Before the first word of a session, at most
   `ORB_OPENING_MAX_TOOL_CALLS` tool calls (default 2, clamped 1–5). The next
   call gets the existing loop-guard guidance. Every other turn keeps the
   policy limit.
2. **Reply cap after the loop guard.** The guidance asks for one short
   sentence. The reply that follows is capped at `ORB_LOOP_GUARD_REPLY_MAX_MS`
   of audio (default 20 s, clamped 5–60 s, measured from the PCM bytes). The
   rest of that turn is muted, and the cap ends with the turn.
3. **Backend data is never spoken.** Nova's own transcript of what it is
   saying runs ahead of its audio. The new text, plus 80 chars before it, is
   checked for things no spoken sentence contains: braces or JSON keys,
   snake_case identifiers, UUIDs, dotted upper-case screen ids. On a match
   the rest of the turn is muted, with the diag `backend_data_speech_suppressed`.
4. **What was said is recorded.** `turn_complete` carries
   `output_preview` (≤240 chars), `output_chars` and `output_suppressed`. The
   incident left no record of the words, because a session with no user turn
   writes no transcript.

Nothing composes speech (NEVER rule 41). No flag to enable; both limits are
env-tunable.

## Acceptance

AC-1: The opening budget defaults to 2, clamps 1–5, applies only before the first word of the session, and never raises a lower policy limit.
TEST: services/gateway/test/orb/live/session/vtid-04480-opening-turn-guard.test.ts

AC-2: Replaying the incident through the real session handlers, the third opening-turn tool call gets the speak-now guidance and is not executed, and the diag says `opening_turn: true`. Later turns keep the normal limit.
TEST: services/gateway/test/orb/live/session/vtid-04480-opening-turn-guard.test.ts

AC-3: After the loop guard, a 70 s reply is cut to about 20 s of forwarded audio, `loop_guard_reply_capped` is emitted, and the next turn is not capped.
TEST: services/gateway/test/orb/live/session/vtid-04480-opening-turn-guard.test.ts

AC-4: Every payload shape from the incident is detected and mutes the rest of the turn, including a key split across two transcript chunks. Ordinary speech in English, German, Spanish and Serbian (amounts, dates, times, domains) is never flagged.
TEST: services/gateway/test/orb/live/session/vtid-04480-opening-turn-guard.test.ts

AC-5: `turn_complete` carries a bounded preview of the turn's words. A turn with no text keeps the bare diag.
TEST: services/gateway/test/orb/live/session/vtid-04480-opening-turn-guard.test.ts

AC-6: No regression in the existing loop-guard, binding, parity and ORB suites; the full gateway suite passes; `tsc --noEmit` is clean.
TEST: services/gateway/test/orb/live/session/upstream-session-binding.test.ts

AC-7 (post-deploy, staging): after the member reopens the ORB on a screen after a navigation, `orb.live.diag` shows at most two `tool_call` rows before `model_start_speaking`. If the guard fires, `tool_loop_guard` carries `opening_turn: true`, and `turn_complete` carries `output_preview` with no backend data in it.
UI: a voice session on https://preview-aws.vitanaland.com, opened after asking Vitana to open the Wallet screen

## Mutation check

Each guard was removed in turn and the suite run: no opening budget → 2 failed;
no reply cap → 1 failed; no leak mute → 2 failed; no preview → 1 failed.

## Not verified live

The fix is verified against the replayed incident, not yet against a real
session on staging. AC-7 is the live check, after the deploy.

## Separate finding, not fixed here

In both sessions the member's personal brain context was not in the
instruction Nova received. The 30 KB instruction budget replaced it with
`[bootstrap context omitted to fit the Vertex Live setup budget]`. The part
that is never trimmed is already about 32.4 KB, so nothing is left for the
personal context. Older sessions show the same, so this predates this change.
