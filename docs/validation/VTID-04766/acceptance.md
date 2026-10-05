# VTID-04766 — the wife's parents were stored as the member's own parents

Production session live-755a02b7 (2026-09-29, 15:45 UTC). The member said "ihr Vater heißt Viktor und die Mutter heißt Tatjana" about his wife's parents.
- The model stored `maria_maksina_father` / `maria_maksina_mother`.
- Six seconds later the remember backstop stored the same names as `father_name` / `mother_name`, his own parents. Its extractor saw one sentence with no idea whose "ihr" was, and knew only plain relation keys.
- His own parents (Marco, Mirjana) then replaced them.
- "wie heißt der Vater meiner Ehefrau" went unanswered.

Fix (facts stay the only store; no second table to keep in sync with the Garden, forget and erasure):
- `services/memory/people.ts`: a fact key names a relation path from the member plus an attribute.
  - `spouse_father_name`, `schwiegervater_name`, `father_in_law_name` all mean wife → father.
  - `maria_maksina_father` means the same once Maria Maksina is the spouse.
- `runRememberFact`:
  - a new relative is stored under its one canonical key;
  - `findRelatedFact` pairs relatives only when they are the same relative. Before, `spouse_father_name` matched `father_name`, which shares two words.
- The extractor prompt:
  - adds chained keys;
  - plain keys are only for the member's own relatives;
  - an unclear "ihr/sein Vater" stores nothing.
- A `<people>` block (who is who by relation) in both voice memory read paths (`orb-memory-bridge` legacy and `recall()`), and in the context pack.

## Acceptance

AC-1: relation keys parse in English, German and by a known relative's name. Keys that name no relative stay null.
TEST: services/gateway/test/services/memory/vtid-04766-people.test.ts

AC-2: the wife's father is never matched to the member's own father; the same relative under two spellings is one fact.
TEST: services/gateway/test/services/memory/vtid-04766-people.test.ts

AC-3: remember_fact saves the wife's father next to the member's father, says already_known for another spelling, and asks only about the same relative.
TEST: services/gateway/test/services/memory/vtid-04766-people.test.ts

AC-4: the people block lists the member's real relatives correctly and reaches the model's context.
TEST: services/gateway/test/services/memory/vtid-04766-people.test.ts

## Data
The member's own rows were corrected on his instruction (2026-09-30): `mother_name` = Mirjana; `spouse_father_name` = Viktor; `spouse_mother_name` = Tatjana.
