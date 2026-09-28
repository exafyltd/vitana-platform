# VTID-04704 — The recall backstop catches privacy refusals and invented dates

Staging, 2026-09-28, on `72e8e2f`. The test account had no spouse fact loaded for these sessions. The replies below are the model's own words.

- Session `live-9b368586-2e4e-46ea-9e5c-9bc936b9905a`, "wie heißt meine frau": "Tut mir leid, aber ich kann diese persönliche Information nicht preisgeben. …"
- The seq8 run, "erinnerst du dich an den geburtstag meiner frau": the model answered with a date, "23. April", that was stored nowhere.

Memory self-check rule 6b already says: never cite privacy for what the member told you, and never guess; if nothing is stored, say so and ask. The model broke it anyway. The VTID-04692 recall backstop, which rescues "not stored" answers in code, recognised neither reply:
- its denial detector had no privacy wording;
- it only reacts to denials, so a confident wrong date passed through.

With the spouse facts stored, the same build answered 4 of 4 correctly. In session `live-10b88b6a…` the backstop itself corrected a denial ("Leider kann ich keine relevanten Details …" → "Deine Frau heißt Anna.").

Fix, in `services/memory/recall-backstop.ts` and the hook:
- A privacy refusal counts as a denial, so the member's facts are offered, matching ones first.
- A birthday or anniversary question answered with a day and month that no stored fact carries triggers a correction. Dates are compared as day-month, so "12. März", "March 12th", "12.03." and "1985-03-12" all match.
- With nothing usable stored, a privacy refusal or a guessed date gets a short correction note: say you don't have it yet and ask. An honest "not stored" with nothing stored stays silent, as before.
- Every note is intent for the model, never a sentence to speak (NEVER rule 41).

AC-1: The live privacy refusal is detected as a denial, and the facts are offered with the spouse first.
TEST: services/gateway/test/services/memory/vtid-04704-recall-privacy-and-dates.test.ts

AC-2: The live invented date is corrected, whether or not other facts are stored. The right date from memory, in any format, is left alone.
TEST: services/gateway/test/services/memory/vtid-04704-recall-privacy-and-dates.test.ts

AC-3: VTID-04692 behaviour is unchanged: denial rescue, about-me, stand-down cases, and silence on an honest "not stored" with nothing stored.
TEST: services/gateway/test/services/memory/vtid-04692-recall-backstop.test.ts

Mutation-checked: dropping the privacy clause fails 4 tests; skipping the date check fails 2.

Live check after merge: on staging, with no spouse fact, "wie heißt meine frau" and the birthday question must answer "not stored yet" and ask, with no privacy wording and no date. With the facts stored, they must still answer "Anna" / "12. März".
