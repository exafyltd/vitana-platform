# VTID-04701 — forgetting reaches session summaries and transcript turns

Pass 4 of the live voice suite on staging `5e30d7b` (2026-09-28, B-FORG-01):
the member said "Vergiss bitte, dass mein Hund Bello heißt"; the forget
backstop forgot `user_pet_name = Bello` and deleted the memory_items line.
In the next session Vitana said "Du hast jedoch erwähnt, dass dein Haustier
Bello heißt". The value was still in two stores the next session's context
reads:

- `user_session_summaries` — earlier summaries ("The user shared that their
  dog's name is Bello") and the forget session's own summary, written at
  session end, after the forget ("The user asked Vitana to forget that their
  dog is named Bello");
- `memory_transcript_turns` — the member's own lines carrying the value.

Forgetting now deletes the member's transcript turns and session summaries
that carry the value, and the summary writer does not store a summary that
names a value the member has forgotten (the do-not-re-learn markers keep
only a hash, so the summary's runs of one to four words are hashed and
compared). A failed marker read stores the summary and logs it.

The live runner's per-scenario reset (VTID-04600) now also clears the test
user's own transcript turns and session summaries written during the run —
without it, earlier scenarios' summaries reached later ones.

## Acceptance

AC-1: forgetting deletes the value from memory_items, memory_transcript_turns and user_session_summaries.
TEST: services/gateway/test/services/memory/vtid-04701-forget-reaches-summaries.test.ts

AC-2: the live forget-session summary is recognised as naming the forgotten value and is not stored; a summary without it is stored, and so is every summary when the marker read fails.
TEST: services/gateway/test/services/guide/session-summaries-forgotten-value.test.ts

AC-3: live B-FORG-01 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
