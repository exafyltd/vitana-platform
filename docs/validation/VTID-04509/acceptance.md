# VTID-04509 — the resume opener ran the suggested step before the user said a word

VTID: VTID-04509

## What happened (staging, 2026-09-24, read-only evidence in `outputs/incident-timeline.txt`)

A returning member (new-day briefing already delivered, ~3 min since the last
conversation) opened the ORB on the Connectors screen. The brain chose the
resume opener (`conv_resume`, register `continue`, next step `next_session`).
That directive is sent to Nova as a **user-role** turn, and its payload names
the tool that performs the step (`execute_with_tool: narrate_guided_session`)
under a rule that says "do not just describe, DO IT".

Nova read the directive as the member's own acceptance. Before saying a word
it called `narrate_guided_session`, whose result is another instruction
("this is the session's real narration, authored in German … translate every
sentence …"). What the member then heard was Vitana talking about the member
in the third person and working through those instructions out loud — the
same thing that was recorded at 14:16 the same day ("…Translation: 'Tap on
the ORB now…' Yes, that's correct. Now,…"). At 13:50 the same opener called
`create_calendar_event` on turn 0 and booked a slot nobody asked for.

Two conditions made it worse: the member's personal context was not in
Nova's instruction (the budget replaced it, see VTID-04480's separate
finding), and register `continue` says "carry on from where you were" — so
there was no thread to carry on except the directive itself.

## Fix

1. **No action before the user's first word** (`opening-turn-guard.ts` +
   `handleToolCall`, shared by Nova, the cascade and the Vertex bridge). On
   the opening turn with no user transcript, any tool the orchestrator
   catalog classifies above `read` — plus the read-classified tools that
   take over the turn (`narrate_guided_session`, `navigate`,
   `navigate_to_screen`, `switch_persona`, `play_music`, `play_podcast`,
   `consult_external_ai`, `offer_action`) — is not run. It is answered with
   guidance to offer the step in the model's own words and never to mention
   the message, a tool or "the user". Diag `opening_action_refused`. Read
   tools (screen, inbox, index) still run within VTID-04480's budget.
2. **The resume directive says what it is.** It now opens by stating it is
   a private instruction the user did not say and must never be repeated or
   described in the third person; it says this turn only offers and calls no
   tool that performs the step; and in register `continue` it says not to
   invent or describe the situation when the previous thread is not visible.

Nothing composes speech (NEVER rule 41). No flag.

## Acceptance

AC-1: Every tool the incidents ran, and the other NBA execution tools, are classified as opening-turn actions; read tools (screen, inbox, index, memory, knowledge, schedule, wallet summary) are not.
TEST: services/gateway/test/orb/live/session/vtid-04509-opening-action-guard.test.ts

AC-2: "Before the first user word" is true only on turn 0, with the model not speaking and no user transcript.
TEST: services/gateway/test/orb/live/session/vtid-04509-opening-action-guard.test.ts

AC-3: The guidance asks for an offer in the model's own words, forbids mentioning the message or "the user", and contains no sentence to recite.
TEST: services/gateway/test/orb/live/session/vtid-04509-opening-action-guard.test.ts

AC-4: Through the real session handlers, `narrate_guided_session` and `create_calendar_event` on turn 0 are not executed; each gets exactly one guard result and the `opening_action_refused` diag.
TEST: services/gateway/test/orb/live/session/vtid-04509-opening-action-guard.test.ts

AC-5: A read tool on turn 0 still runs (the working 16:01 inbox opener), and in a mixed batch the read runs while the action is refused.
TEST: services/gateway/test/orb/live/session/vtid-04509-opening-action-guard.test.ts

AC-6: Once the user has spoken, or on any later turn, the same tool runs normally.
TEST: services/gateway/test/orb/live/session/vtid-04509-opening-action-guard.test.ts

AC-7: The resume directive carries the private-instruction line, the offer-only rule for this turn and the no-invention rule for `continue`; the six `conv_resume` golden snapshots change by exactly those lines.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts

AC-8: No regression: the ORB, conversation and route suites and the full gateway suite pass; `tsc --noEmit` is clean. One binding test that exercises tool-failure handling moved its fixture past the opening turn (its subject is failure framing, not the opening).
TEST: services/gateway/test/orb/live/session/upstream-session-binding.test.ts

AC-9 (post-deploy, staging): a returning member reopening the ORB within a few minutes hears one short offer spoken to them; `orb.live.diag` shows `opening_action_refused` or no action tool before `model_start_speaking`, and `turn_complete.output_preview` contains no third-person talk about "the user".
UI: a voice session on https://preview-aws.vitanaland.com, reopened within ~3 minutes of the previous one

## Not verified live

Verified against the replayed incident through the real session handlers, not
yet against a real staging session. AC-9 is the live check after the deploy.

## Not fixed here

- The personal context omitted from Nova's instruction by the 30 KB budget
  (recorded under VTID-04480) is why the model had no thread to continue.
- A turn the member cuts off before `turn_complete` still records no words
  (the reported session left no transcript).
