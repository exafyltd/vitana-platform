# VTID-04712 — recall backstop: wo-compound questions and "lass mich nachsehen"

Pass 7 of the live voice suite on staging `7045c16` (2026-09-28, B-SELF-02):
the member had saved "I'm allergic to penicillin". In the next session,
"Worauf bin ich allergisch?" got "Ich kann dir dabei helfen, deine Allergien
zu überprüfen. Lass mich kurz in deinen Aufzeichnungen nachsehen." and the
turn ended. The recall backstop never ran: "worauf" was not a question word
and "lass mich … nachsehen" was not a deferral.

The question words now include the German wo-compounds (worauf, wovon,
womit, …) and the "why" words; the deferral list includes "lass mich …
nachsehen/prüfen", "let me quickly check" and the Serbian "daj da pogledam".

## Acceptance

AC-1: "Worauf bin ich allergisch?" and other wo-compound questions about the member are detected; "Worauf wartest du?" is not.
TEST: services/gateway/test/services/memory/vtid-04712-recall-wo-questions.test.ts

AC-2: the live reply and the new deferral phrasings are deferrals; a direct answer is not.
TEST: services/gateway/test/services/memory/vtid-04712-recall-wo-questions.test.ts

AC-3: the live turn runs the backstop and offers the allergy fact.
TEST: services/gateway/test/services/memory/vtid-04712-recall-wo-questions.test.ts

AC-4: live B-SELF-02 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
