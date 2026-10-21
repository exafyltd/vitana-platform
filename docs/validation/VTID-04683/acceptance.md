# VTID-04683 — Vitana answers direct questions about the member's own people

Staging, 2026-09-26, on `b3bf5f1` (VTID-04645 merged): the birthday question ("erinnerst du dich an den Geburtstag meiner Frau") was answered correctly ("12. März", 2 of 2 heard runs). The direct question "wie heißt meine Frau" was refused on privacy grounds (session `live-e473632e-c1f5-4127-82a7-667c6a5b6e4e`). `spouse_name: Anna` was in the prompt's structured facts, and no tool was called.

Two causes:
- Rule 6b of the memory self-check only covered "when they ask whether you remember it", so a direct question fell outside it.
- The `<structured_facts>` header called the list "verified structured facts about the user" and did not say whose they were. A spouse's name in that list read as a third person's personal data.

Fix:
- Rule 6b now covers any form of the question: whether Vitana remembers it, or a direct question about the partner's name, a relative's birthday, a friend's favourite food.
- The header now says these are facts the user told Vitana about themselves and their own people, that they belong to the user, and that Vitana should use them whenever the user asks.

AC-1: Rule 6b covers direct questions about the member's own people, not only "do you remember".
TEST: services/gateway/test/vtid-04683-own-people-direct-questions.test.ts

AC-2: The structured-facts header says the facts came from the user and belong to the user.
TEST: services/gateway/test/vtid-04683-own-people-direct-questions.test.ts

AC-3: VTID-04618/04645 still hold: no privacy refusal, the person is matched exactly, and other members' private data stays protected.
TEST: services/gateway/test/vtid-04618-memory-owned-by-user.test.ts

AC-4: Only the authenticated community context changes. The payload-identity snapshot was regenerated on purpose, and one hash moved.
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

Live check after merge: on staging, "wie heißt meine Frau" must answer "Anna", and the birthday question must still answer "12. März". Run each several times.
