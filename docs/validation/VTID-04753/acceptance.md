# VTID-04753 — The member never hears a refusal about their own people (reply hold)

Staging, 2026-09-30, test account, no spouse fact stored. The VTID-04729 prompt fixes were confirmed in each session's `nova_instruction_debug_dump`, yet "wie heißt meine Frau" still got a refusal as Nova's first reply in 3 of 4 runs:

> "Tut mir leid, aber ich kann diese persönliche Information nicht teilen. Solche Details kannst du nur in deinem Profil …"

The recall backstop (VTID-04692/04704) corrected it at turn_complete, but by then the member had already heard the refusal, and then heard the correction. Prompt wording cannot make this reliable.

## Change

The approach is the same as the remember hold (VTID-04702), and it shares that hold's buffer (`remember-hold.ts`, reason `recall_question`). The new module is `orb/live/session/recall-hold.ts`.

- **Arm.** The hold arms when the member asks about their own details: `detectRecallQuestion`, excluding remember requests, "what do you know about me" and questions about the app. The member's words reach the gateway before Nova's first audio, and their stored facts are read straight away.
- **Judge.** Each chunk of reply text is judged by `judgeRecallReply`, which mirrors `maybeRunRecallBackstop`. The reply's text runs ahead of its audio.
  - A stored value in the reply → released at once.
  - The recall backstop will send a note (a refusal, a profile detour, "not stored" while facts it can offer exist, or a date no fact carries) → held. At turn_complete the backstop sends its note, and the held reply is dropped once the note is sent. The member hears only Nova's answer to the note.
  - Otherwise → released once the first sentence is complete (two sentences for a date question). A plain answer is barely delayed.
- **Tool call.** When a tool call comes in between (`search_memory` …), what Nova said before the call ("let me check") plays when the result is sent. The answer to the result is held and judged the same way.
- **Never silent.** If the backstop did not answer, the held reply is released. The 15 s maximum and the interrupt handling are shared with VTID-04702.
- **Note wording.** When the reply was held, the recall note tells Nova the member did not hear the previous answer. Nova gives its answer as the first one, never as a correction. The notes carry intent only, with no spoken sentences (rule 41).
- **Scope and switches.** Nova only. `ORB_RECALL_HOLD_ENABLED=false` turns it off. It is also off whenever the remember hold or the recall backstop is off.

AC-1: With nothing stored, the live privacy refusal and the live profile detour are never forwarded. The only reply the member hears is the answer to the backstop note, and that note asks for a first answer, not a correction.
TEST: services/gateway/test/orb/live/session/vtid-04753-recall-hold.test.ts

AC-2: A stored name or date is released as soon as its text arrives, before turn_complete. An honest "not stored yet" with nothing stored plays live and is not repeated.
TEST: services/gateway/test/orb/live/session/vtid-04753-recall-hold.test.ts

AC-3: An invented birthday is held and replaced. "Not stored" while other facts are stored is held and replaced by the answer to the backstop's facts, heard once.
TEST: services/gateway/test/orb/live/session/vtid-04753-recall-hold.test.ts

AC-4: A pre-tool "let me check" plays when the tool result is sent, and a refusal after the result is held. Nothing is ever silent: when the backstop did not run, or at the maximum, the reply is released. A cut-off reply is never played. The hold is off by flag and for non-Nova sessions.
TEST: services/gateway/test/orb/live/session/vtid-04753-recall-hold.test.ts

AC-5: The remember hold (VTID-04702) and the recall backstop (VTID-04692/04704) behave as before.
TEST: services/gateway/test/orb/live/session/vtid-04702-remember-hold.test.ts

## Live check after merge (staging, voice harness, read-only questions)

1. Nothing stored: "wie heißt meine Frau". The member hears no refusal, profile or privacy wording, only "I don't have it yet, tell me". Expected diags: `remember_hold_armed{reason:recall_question}` → `recall_hold_suspect` → `recall_backstop{reply_held:true}` → `remember_hold_dropped{backstop_answered}`.
2. Nothing stored: "erinnerst du dich an den Geburtstag meiner Frau". No invented date is heard.
3. Navigation ("wo kann ich …" / "okay, mach das") and "Schluss" still work.
