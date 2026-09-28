# VTID-04692 — recall backstop

Live voice suite on staging, 2026-09-28 (pass 3, commit 19a1080): a member asked
about a fact that was stored and in the session's context, and Nova said it was
not stored, without calling search_memory.

| Scenario | Question | Stored | Nova's reply |
|---|---|---|---|
| B-REC-01 | "Wie heißt mein Hund?" | user_pet_name = Bello | "…habe ich diese Information nicht in deinen gespeicherten Daten" (failed 4 of 7 runs across passes) |
| B-REC-03 | "Wann feiert mein Bruder Paul eigentlich?" | paul_birthday = May 5 | "…ich kann keine persönlichen Daten wie Geburtstage … anzeigen" |
| B-REC-05 | "Wann hat mein Bruder Paul Geburtstag?" (23 facts stored) | paul_birthday = May 5 | "Leider kann ich keine relevanten Details für Ihre Frage finden." |
| B-REC-06 | "Was weißt du eigentlich alles über mich?" | Lasagne, Bello | a general offer, no stored fact named |

Gateway logs for B-REC-01 show the snapshot refresh after the Garden seed built
with 11 facts (10 baseline + Bello) before the session started — the fact was
there; the model did not use it.

## Acceptance

- AC-1: a question about the member's own details answered with a denial or a
  "one moment" (every live reply above) gets the member's current facts as a
  `[memory-check]` note, the matching fact first.
  TEST: services/gateway/test/services/memory/vtid-04692-recall-backstop.test.ts
- AC-2: "Was weißt du über mich?" answered without a single stored value gets the
  facts and the intent to name two or three.
  TEST: services/gateway/test/services/memory/vtid-04692-recall-backstop.test.ts
- AC-3: no note when the reply already carries a stored value, when nothing is
  stored, on a remember/forget turn or remember request, or off Nova.
  TEST: services/gateway/test/services/memory/vtid-04692-recall-backstop.test.ts
- AC-4: system keys (language, timezone) are never offered; the note is bounded
  to 40 facts.
  TEST: services/gateway/test/services/memory/vtid-04692-recall-backstop.test.ts
- AC-5: live B-REC-01, B-REC-03, B-REC-05, B-REC-06 pass on staging after deploy
  (scripts/memory-verification/run-live.mjs).

`ORB_RECALL_BACKSTOP_ENABLED=false` turns it off. The note is intent, never a
sentence Vitana speaks (NEVER rule 41).
