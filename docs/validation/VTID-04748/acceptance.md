# VTID-04748 — "lösche den Namen meines Hundes" deleted nothing

Production live-11ec418b (2026-09-29). The member asked twice to delete the dog's name. Vitana said it was deleted, and both hunde_name and user_pet_name (Bello) stayed.

Why:
- The forget intent required a memory word next to "lösch".
- The matcher did not know "Hundes" or "Namen", and did not treat a dog as a pet.

Fixes:
- A loose forget intent (lösch/entfern/delete/remove) now reaches the backstop. On that path the backstop acts only when a stored fact matches; otherwise it stays silent, so "lösche den Termin" is never taken as a memory delete.
- New key words: hunde, hundes, katzen, namen, firma, unternehmen.
- A dog or a cat request also matches pet keys.
- The same value stored under two keys counts as one fact, so both keys are forgotten instead of Vitana asking which one.

## Acceptance

AC-1: both live requests are forget requests, and they match both keys holding Bello without being ambiguous. Two different values are still ambiguous.
TEST: services/gateway/test/services/memory/vtid-04748-loeschen-forget.test.ts
