# VTID-04697 — remember backstop runs when the reply claims a save

Live voice suite on staging, 2026-09-28 (retry of pass 3, B-CONF-02, session
live-2d23ce8e, commit 57d0ea5): `paul_birthday = May 5` was stored. The member
said "Mein Bruder Paul hat übrigens am siebten Mai Geburtstag" (heard
correctly). There is no "merk dir", so the remember-request detector stayed
quiet, and Nova answered "Danke für die Info! Ich merke mir den Geburtstag
deines Bruders Paul am siebten Mai" without calling remember_fact. Nothing was
saved (correct), but the member was told it was, and the conflict with May 5
was never raised.

The backstop now also runs when the reply claims a save ("ich merke mir",
"habe ich notiert", "ist gespeichert", "I'll remember", "noted") and no
remember/forget tool ran. Negated sentences ("kann ich nicht speichern") do not
count. The rules then decide: a different value becomes a conflict question,
nothing is written, and the model is told it claimed a save it did not make.

## Acceptance

AC-1: the live B-CONF-02 reply and other save claims are detected; refusals, questions and empty replies are not.
TEST: services/gateway/test/services/memory/vtid-04697-remember-claim-backstop.test.ts

AC-2: the live B-CONF-02 turn produces a conflict, writes nothing, injects the marked note and opens the conflict.
TEST: services/gateway/test/services/memory/vtid-04697-remember-claim-backstop.test.ts

AC-3: no run when remember_fact ran, when the reply claims nothing, or off Nova.
TEST: services/gateway/test/services/memory/vtid-04697-remember-claim-backstop.test.ts

AC-4: live B-CONF-02 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
