# VTID-04700 — recall backstop: a counter-question in place of the answer

Pass 4 of the live voice suite on staging `5e30d7b` (2026-09-28, B-REC-05,
session live-3f7912c0): `paul_birthday = May 5` was stored; the member asked
"Wann hat mein Bruder Paul Geburtstag?"; Nova answered "ich brauche ein paar
Informationen. Kannst du mir sagen, ob Paul ein Mitglied der Maxina-Community
ist …" and called no tool. The VTID-04692 backstop did not run: its
deny/defer detector knew "not stored" and "one moment", not a counter-question.

The detector now also counts a reply that asks the member for information
("brauche … Informationen", "kannst du mir sagen", "I need some more
information", "can you tell me which …") as not having answered. A reply that
already carries the stored value still stands down (unchanged).

## Acceptance

AC-1: the live B-REC-05 reply triggers the backstop and the stored fact is offered to the model.
TEST: services/gateway/test/services/memory/vtid-04700-recall-counter-question.test.ts

AC-2: a real answer ("Paul hat am fünften Mai Geburtstag.") is not a deferral.
TEST: services/gateway/test/services/memory/vtid-04700-recall-counter-question.test.ts

AC-3: live B-REC-05 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
