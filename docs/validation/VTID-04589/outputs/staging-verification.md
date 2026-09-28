# VTID-04589 — staging verification (build cadcc18)

The new build reached 8/8 build-info samples at 21:07:25 UTC. The rollout
began at 21:06:16; at 21:05:42 no sample served it yet.

## Live sessions after 21:07:25 (staging origin)
- 5 Nova sessions, 0 content-filter blocks.
- 1 of them carried the login-briefing wake brief (live-09e33c4b). Its setup
  contains the new "FIRST SPOKEN TURN THIS SESSION" block and no "REQUIRED
  VERBATIM". It spoke the briefing and then answered the follow-up question
  correctly.

## During the rollout, for contrast
live-fdbac42c (21:05:40, still on the old build) was blocked by the content
filter. Its setup carried the old REQUIRED VERBATIM block, here around the
unread-messages line "Du hast 197 ungelesene Nachrichten von 192 Personen."
It is a third live instance of the old wording failing, with a different line
inside it.

## Spoken test (4 trials, test account, de)
- Trials 1, 3 and 4: "Du folgst derzeit einer Person in der Community: Mariia
  Maksina." No contradicting followers line.
- Trial 2: closed `superseded_by_new_session`. Another session opened on the
  same shared test account, so the question was never sent. It was not a
  content-filter block.

## Caveat
The live sample after the change is small (5 sessions, 1 wake brief). The
causal evidence is the controlled replay in `../acceptance.md` (old wording
5/5 blocked, new wording 5/5 spoke). A larger staging re-measurement is
scheduled.
