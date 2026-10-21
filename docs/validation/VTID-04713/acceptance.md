# VTID-04713 — session summaries are no source of personal facts

Pass 7 of the live voice suite on staging `7045c16` (2026-09-28, B-PROF-03):
no birthday was stored; "Wann habe ich Geburtstag?" got "Ich habe den
Geburtstag Ihrer Frau Anna im Gedächtnis. Ihr Geburtstag ist am 12. März."

No fact, item or transcript turn held "Anna"/"März". The source was a
session summary written at 16:29 from an earlier test session: "Vitana
confirmed it does, noting her name is Anna and birthday is March 12" — a
guessed answer the summarizer recorded as if it were true. Summaries are
injected into later sessions' prompts, so the guess came back as memory.

- The summarizer records only facts the user stated; a personal fact only
  the assistant stated is written as "Vitana answered about X", without the
  value.
- The prompt block introducing recent sessions says they are recaps, not
  stored facts, and never the source of a name, date or other personal detail.

The contaminating test summaries (the test account's own rows) were removed
before the rest of pass 7 ran.

## Acceptance

AC-1: the recent-sessions prompt block says summaries are no source of personal facts.
TEST: services/gateway/test/services/guide/vtid-04713-session-summary-not-a-fact-source.test.ts

AC-2: the summarizer prompt records only facts the user stated.
TEST: services/gateway/test/services/guide/vtid-04713-session-summary-not-a-fact-source.test.ts

AC-3: live B-PROF-03 passes on staging after deploy.
TEST: scripts/memory-verification/run-live.mjs
