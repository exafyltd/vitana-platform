# VTID-04705 — recall backstop: questions about the member with "ich"

Pass 6 of the live voice suite on staging `fcf53eb` (2026-09-28, B-PROF-03,
session live-9f36f080): no birthday was stored; the member asked "Wann habe
ich Geburtstag?"; Nova answered only "Ich überprüfe das für dich. einen
Moment bitte." and the turn ended, with no tool call. The VTID-04692 recall
backstop did not run: its question detector required a possessive ("mein",
"my") and "habe ich" has none.

The detector now also counts a question with the verb directly before the
pronoun — "habe ich", "bin ich", "wohne ich", "was I", "do I" — as a question
about the member. The backstop then offers the stored facts, and the model
answers from them or says plainly that nothing matching is stored.

## Acceptance

AC-1: the live B-PROF-03 turn is detected and the backstop offers the stored facts.
TEST: services/gateway/test/services/memory/vtid-04705-recall-first-person.test.ts

AC-2: statements and questions not about the member ("Was kann ich heute machen?", "Ich habe Hunger.") are not detected.
TEST: services/gateway/test/services/memory/vtid-04705-recall-first-person.test.ts

AC-3: live B-PROF-03 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
