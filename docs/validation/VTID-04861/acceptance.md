# VTID-04861 — A repeated fact under a related key is one row (live B-DUP-01)

Memory suite layer B on staging `e36e486`, 2026-10-01, B-DUP-01 failed both runs. "Merk dir, mein Hund heißt Bello", said in two sessions, left two current rows: `dog_name = bello` and `user_pet_name = Bello`.

- **Session 1 (`live-6dc82d94`):** the voice model saved `hunde_name`, which was stored as `dog_name`. The background extractor stores pets as `user_pet_name` (its prompt names that key), and its related-key check, `findRelatedFact`, did not relate `pet` to `dog`.
- **Session 2 (`live-004d1339`):** the voice model got `already_known` for `dog_name`, but the second row was already there.

## Finding

This is already fixed on main by VTID-04766 (#3837, `8d661aa`): relatives are matched by relation, and `pet` covers `dog` and `cat` (`people.ts`). That commit is not in the build the suite ran on (`e36e486`), so no code change is needed here. This VTID pins the live case so it stays fixed.

AC-1: `user_pet_name` finds the stored `dog_name` and the other way round. A dog is never a cat. A pet's breed or vet is not its name.
TEST: services/gateway/test/services/memory/vtid-04861-04863-remember-save-fixes.test.ts

AC-2: `remember_fact` with "hunde_name = bello" and `user_pet_name = Bello` stored is `already_known`, and nothing is written.
TEST: services/gateway/test/services/memory/vtid-04861-04863-remember-save-fixes.test.ts

## Not changed (noted)

When a dog and a cat are both stored, `user_pet_name` matches the newer of the two (VTID-04766 behaviour). This has not been seen live, so it is left as is.
