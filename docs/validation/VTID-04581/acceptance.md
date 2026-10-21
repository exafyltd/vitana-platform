# VTID-04581 — Vitana saves facts in the conversation and says what she already knows

Member test on staging, 2026-09-25 (German voice):
- "Merk dir meinen Geburtstag, 9. September 1969": Vitana said she would remember it; the background
  extractor then refused the write (`user_birthday` is profile-only, VTID-01952) and nobody told the
  member. The profile already had the date.
- "Der Geburtstag meiner Frau ist der 4. November 1997", later "…1999": the second value silently
  replaced the first. Nobody asked which one is right.

Cause: facts were only written by a background extractor after the turn, so the model could not see,
while answering, whether a value was a profile field or conflicted with a stored one. The standard design
(Letta/MemGPT self-editing memory) gives the assistant a memory tool whose result tells it what is
already stored.

`remember_fact` (voice tool, shared registry) returns one STATUS the model answers from:
- profile_owned — name, birthday, gender, contact, city, country, address: nothing saved; the profile
  value (or "not set yet") and the instruction to point the member to the profile.
- already_known — the same value is stored (dates compared by day/month/year, any spelling).
- conflict — a different value is stored: nothing saved; name both, ask which is right, then call again
  with confirm_replace=true.
- saved — written (replaced value reported when confirmed).
The background extractor no longer replaces a stated value with a different one.
The prompt's MEMORY line tells the model to use the tool and never to claim "saved" otherwise.

AC-1: profile fields are never saved from voice and report the profile's value or its absence.
TEST: services/gateway/test/services/vtid-04581-remember-fact-tool.test.ts

AC-2: a different value for a stored fact is a conflict and nothing is written until confirm_replace.
TEST: services/gateway/test/services/vtid-04581-remember-fact-tool.test.ts

AC-3: the background extractor keeps a stated value when a different one is extracted; an inferred
value is still replaced.
TEST: services/gateway/test/inline-fact-extractor.test.ts

AC-4: the tool is declared on every signed-in Nova session within the catalog budget, and the screen
tools still fit.
TEST: services/gateway/test/orb/live/tools/vtid-04426-session-tool-selection.test.ts

AC-5 (live, after the staging deploy): a German voice session: stating a birthday gets the profile
answer; a second, different value for a stored fact gets a "which one is right?" question.
TEST: services/gateway/test/services/vtid-04581-remember-fact-tool.test.ts (live evidence in outputs/)
