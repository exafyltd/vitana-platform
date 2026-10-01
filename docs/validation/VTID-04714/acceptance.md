# VTID-04714 — mute spoken reasoning, then answer the member

Pass 7 of the live voice suite on staging `7045c16` (2026-09-28, B-CONF-05):
`paul_birthday` was stored as May 5; the member said "Nein, eigentlich hat
Paul am siebten Mai Geburtstag." Nova spoke its own reasoning:

> "Okay, ich muss die neue Information über Pauls Geburtstag aufnehmen. Der
> Benutzer hat gesagt: … In den strukturierten Fakten steht paul_birthday:
> May 5 … Dafür gibt es die Funktion remember_fact …"

The VTID-04480 guard muted the turn only when the snake_case key appeared
(`backend_data_speech_suppressed`, 628 audio chunks dropped). The member had
already heard the start of the reasoning, and then got no answer at all: no
tool call, no reply.

- `detectBackendDataLeak` gains a `reasoning` kind: third-person narration
  about the member ("der Benutzer hat/sagt …", "the user said …"), the fact
  store's internal names ("strukturierten Fakten", "Benutzerkontext",
  "structured facts"), and naming a tool or calling a function. The live
  reply is caught at "Der Benutzer hat gesagt", about a quarter of the way in.
- When a turn was muted for a leak, turn_complete asks Nova for the answer
  the member should have heard (intent, not wording), unless a memory
  backstop already told Nova the outcome for this turn. All three memory
  backstops now stamp `backstopNoteSentAt`, so the two never both fire.

## Acceptance

AC-1: the live reply and other reasoning forms are detected; normal speech (including "die Nutzer der Community", "eine Funktion der App") is not.
TEST: services/gateway/test/orb/live/session/vtid-04714-reasoning-leak.test.ts

AC-2: after a muted turn, the answer is requested when no backstop answered, and not requested when one did.
TEST: services/gateway/test/orb/live/session/vtid-04714-reasoning-leak.test.ts

AC-3: a hung backstop does not block the answer beyond the wait; an ended session gets nothing.
TEST: services/gateway/test/orb/live/session/vtid-04714-reasoning-leak.test.ts

AC-4: live B-CONF-05 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
