# VTID-04702 — save first, then answer

Live B-PROF-01 on staging (2026-09-28, session live-aa2fe0bd): the member
said "Merk dir bitte, mein Geburtstag ist der neunte September 1969". Nova
answered "Ich habe dein Geburtsdatum notiert" with no tool call; the member
heard a save that never happened. The turn_complete backstop then ran the
save logic (a birthday belongs in the profile) and Vitana corrected herself
— after the false sentence had played.

Nova writes the reply itself, but the gateway forwards every audio chunk to
the member, and the member's words reach the gateway first (B-PROF-01:
transcript 14:44:09.5, first reply audio 14:44:15.2). So the gateway now
holds the reply of a remember turn:

- armed when the member asks Vitana to remember something, or when the reply
  text (which runs ahead of its audio) claims a save while no remember/forget
  tool has been called;
- while armed, the reply's audio and text are buffered, not forwarded;
- Nova called remember_fact/forget_fact: what it said before the tool result
  is dropped — it may claim a save that failed or conflicted — and its reply
  to the result, which states the real outcome, plays live;
- no tool call: at turn_complete the backstop saves and tells Nova the
  result; the held reply is dropped and Nova's next reply, which states the
  real outcome, is the one the member hears. The note tells Nova the member
  did not hear its previous answer, so the outcome comes as the answer, not
  as a correction;
- the backstop did not run, sent no note, or took more than 6 s: the held
  reply plays, late rather than never. A timer releases any hold after 15 s,
  even if no further event arrives.

A held reply the member never heard is not stored in the transcript, bridged
to chat or sent to extraction.

Nova only; `ORB_REMEMBER_HOLD_ENABLED=false` turns it off. Cost: the member
hears the reply to a remember request once the save is done (about 1–3 s later).

## Acceptance

AC-1: live B-PROF-01 — the "notiert" reply is never forwarded (audio or text); the reply after the backstop's note plays live.
TEST: services/gateway/test/orb/live/session/vtid-04702-remember-hold.test.ts

AC-2: when Nova calls remember_fact, what it said before the result is dropped (also when the write failed) and its reply to the result plays.
TEST: services/gateway/test/orb/live/session/vtid-04702-remember-hold.test.ts

AC-3: a remember turn never ends silent — when the backstop does not answer, the held reply plays.
TEST: services/gateway/test/orb/live/session/vtid-04702-remember-hold.test.ts

AC-4: turns that are not about remembering, non-Nova sessions and the kill switch play live, unchanged.
TEST: services/gateway/test/orb/live/session/vtid-04702-remember-hold.test.ts

AC-6: a held reply the member cuts off (barge-in) is never played afterwards; the hold re-arms for the reply that follows.
TEST: services/gateway/test/orb/live/session/vtid-04702-remember-hold.test.ts

AC-7: a dropped reply is not stored as something Vitana said, and any hold is released by its 15 s timer when nothing else arrives.
TEST: services/gateway/test/orb/live/session/vtid-04702-remember-hold.test.ts

AC-5: live B-PROF-01 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
