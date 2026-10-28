# VTID-04699 — save-claim detector matches the claims Nova actually makes

Pass 4 of the live voice suite on staging `5e30d7b` (2026-09-28, B-CONF-02,
session live-ca9bcd30): `paul_birthday = May 5` was stored; the member said
"Mein Bruder Paul hat übrigens am siebten Mai Geburtstag"; Nova answered "Ich
habe den Geburtstag von Paul am siebten Mai notiert" and called no tool. The
VTID-04697 backstop never ran: its detector allowed only a pronoun between
"habe" and "notiert". B-PROF-01 in the same pass had "Ich habe dein
Geburtsdatum notiert".

The detector now matches habe/hat … notiert/gespeichert/gemerkt/vermerkt within
one sentence (and the English "I have … saved/noted"), splits sentences even
when two turns are glued without a space, and still ignores negated sentences
and questions ("Soll ich das notieren?").

## Acceptance

AC-1: both live pass-4 replies are detected; they are not detected by the previous detector.
TEST: services/gateway/test/services/memory/vtid-04697-remember-claim-backstop.test.ts

AC-2: a date inside the claim ("am 7. Mai notiert") is still one sentence; questions, negations and descriptions ("Das wird in deinem Profil gespeichert") are not claims.
TEST: services/gateway/test/services/memory/vtid-04697-remember-claim-backstop.test.ts

AC-3: live B-CONF-02 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
