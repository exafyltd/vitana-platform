# VTID-04592 — close the conversation when the member asks to stop and Vitana agrees

## Problem (production, read-only diagnosis)
Session live-6786b50c, 2026-09-25 22:39–22:41 UTC, vitanaland.com, de, Nova Sonic.
The member asked Vitana to stop nine times: "du sollst gehen", "geh jetzt",
"du sollst gehen mach zu hör auf", "schalte ab", "geh weg", and "schluss" x4.
Vitana replied "Ich schalte mich jetzt ab" or "Ich beende jetzt das Gespräch"
each time. The session has **zero `tool_call` diags**: `end_conversation` was
never called, so after every farewell the widget returned to listening. The
session ended only on `client_disconnect`, when the member closed the app.

`end_conversation` is still declared (on 2026-09-25 it fired twice), so it has
not been removed from the catalog. This is the Nova compliance gap VTID-03824
recorded. Its code backstop only matches "du bist (immer) noch da", which the
member never said.

## Change
- `end-conversation-intent.ts` (pure, EN/DE): `detectUserStopIntent`,
  `detectAssistantAgreedToEnd` and `shouldEndConversationAfterTurn`, which
  requires both signals in the same turn.
- `handleTurnComplete`: when both signals are present, the gateway sends the
  same `orb_directive: end_conversation` the tool would (reason
  `stop_request_acknowledged`). The widget's existing handler lets the
  farewell finish, then closes.
- `dispatchEndConversationDirective` is idempotent per session, so the tool,
  the still-here backstop and this backstop together send the close at most
  once.

## Acceptance criteria
AC-1: Every stop request from the production session is recognised.
TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts — "recognises every stop request from the production session"

AC-2: Vitana's agreeing replies are recognised.
TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts — "recognises the replies in which Vitana agreed to stop"

AC-3: Ordinary talk, including a bare "hör auf" / "stop" and "lass uns später reden", is not a stop request.
TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts — "does not treat ordinary talk as a stop request"

AC-4: Both signals are required.
TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts — "needs both signals"

AC-5: Through the real handler, "schluss" + an agreeing reply sends exactly one end_conversation directive; "hör auf" answered with help sends none.
TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts — "sends the end_conversation directive once" / "does not close when the member says stop and Vitana keeps helping"

AC-6: The directive is sent at most once per session.
TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts — "the directive is sent at most once per session"

AC-7: On staging, a spoken "schluss" makes the session emit `conversation_ended` (reason stop_request_acknowledged or the tool's own) and the widget close.
UI: staging voice session with the test account; oasis_events orb.live.diag stage=conversation_ended

## Round 2 (after staging round 1 — see outputs/staging-round1.txt)

- AC-8: an unambiguous request ("schalte dich ab", "du sollst gehen", a bare "Schluss.") closes even when Vitana refuses or does not say goodbye.
  TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts
- AC-9: "Ich wünsche dir einen schönen Tag" / "dass du die Unterhaltung beenden möchtest" count as agreeing to stop.
  TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts
- AC-10: "hör auf", "stop talking", "schluss" inside a sentence still need Vitana to agree.
  TEST: services/gateway/test/orb/live/session/vtid-04592-end-conversation-backstop.test.ts
