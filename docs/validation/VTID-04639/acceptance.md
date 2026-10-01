# VTID-04639 — one row per fact across languages and writers

Found by the live memory suite (VTID-04600, pass 1 on staging build `1335b48`):
the same fact was stored twice, under a German key chosen by the voice model's
`remember_fact` call and an English key from the background extractor —
`lieblingsessen` + `user_favorite_food`, `allergie` + `user_allergy`,
`hund_name` + `user_pet_name`, `zahnarzttermin` +
`upcoming_event_dentist_appointment`.

Two causes: `keyTokens` treated a multi-word synonym target as one token and
knew no German word for allergy or appointment; the extractor matched keys
exactly (layer-A gaps A-DUP-03, A-CONF-09).

AC-1: remember_fact with a German key for a fact stored in English answers already_known and writes no second row.
TEST: services/gateway/test/memory-verification-conformance.test.ts

AC-2: The background extractor writes under the related stored key, so a German-key fact gets no English duplicate.
TEST: services/gateway/test/memory-verification-conformance.test.ts

AC-3: Layer-A gaps A-DUP-03 and A-CONF-09 are closed (their it.failing markers removed, both pass).
TEST: services/gateway/test/memory-verification-conformance.test.ts

AC-4: "birthday" alone still never matches "paul_birthday" (existing findRelatedFact tests green).
TEST: services/gateway/test/memory-verification-conformance.test.ts

AC-5: Each half is mutation-checked (extractor lookup off: A-DUP-03, A-DUP-08, A-CONF-09 fail; synonym split off: A-DUP-07 fails).
TEST: services/gateway/test/memory-verification-conformance.test.ts
