# VTID-04015 — VTID-04014's fix only partially resolved the Vertex 1007 close

## Reported

Self-discovered while re-verifying VTID-04014 (merged `ecfc0df`, deployed to
staging) against real, live authenticated `lang:'sr'` traffic — the same
standard held for VTID-04010 and VTID-04014 themselves. VTID-04014's fix
(dropping the "translate/verbatim" framing for the same "lead to compose
from" pattern `override_v2` uses) genuinely fixed the 100%-failure
regression — one trial produced perfect, fluent, idiomatic Serbian
("Dobar dan, e2etest33. Prošli put smo radili na temi „Šta je Vitanaland".
Hoćemo li da objavimo brzinsku novost za zajednicu? Ti diktiraš, ja
objavljujem.") — but a larger sample (11 authenticated trials across two
batches) showed only **2/11 succeeded**; the other 9 hit the exact same
`upstream_ws_close code:1007 reason:"Request contains an invalid
argument."` signature VTID-04014 was written to eliminate.

## Root cause

VTID-04014's directive still explicitly NAMED the target language and
repeated "no English":

> Speak entirely in \<lang\> — use no English words. ... compose the
> wording yourself in \<lang\>; ...

The `override_v2` rung (rung 8, immediately above this one, in the same
file) — measured reliable at 24/24 wake_opener events in production per
this repo's own history — NEVER names a specific target language or says
"use no English" at all. It only says "compose the wording yourself in the
user's own language", once, generically, and relies entirely on the
session's own top-level "Respond ONLY in {language}" system instruction to
select the actual language. Explicitly naming the language and repeating
"no English" is a second, competing language directive layered on top of
the system prompt's own one — the same "extra directive fighting the base
instruction" shape (just inverted) as the ORIGINAL English-leak bug this
rung exists to fix.

## Fix

Removed `langName`/`LOCALE_ENGLISH_NAME` from the `safe_fast_proactive`
directive entirely. It now matches `override_v2`'s generic phrasing:

```
Open the conversation from this prepared lead (written in English for your
reference): "<line>"
Compose the wording yourself, entirely in the user's own language for this
session — never in English. Keep every concrete fact from the lead (names,
titles, numbers) and the same single proposal exactly as given, but do not
recite the lead word for word and do not translate it literally. Then
stop — do not add a question beyond the proposal already in the lead, and
do not split it into multiple turns.
```

"Never in English" (generic, no named language) is kept as the one
substantive addition versus `override_v2`'s own wording, since this rung's
specific historical bug (VTID-04010) was an English-language leak — but no
specific language is ever named.

## Acceptance Criteria

AC-1: the directive no longer names a specific target language anywhere
(no `LOCALE_ENGLISH_NAME` lookup, no "Speak entirely in X").
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  ("rung 4: safe_fast_proactive never names a specific target language,
  even for Serbian (VTID-04015 follow-up)")

AC-2: the directive matches `override_v2`'s generic "in the user's own
language" framing and still says "never in English".
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  ("rung 4: safe_fast_proactive (pre-fetched proactive line)")

AC-3: the VTID-04014 regression guard (no verbatim/translate-literally
instruction) still holds under the new directive.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  ("rung 4: safe_fast_proactive never instructs literal recitation/translation
  of the lead (VTID-04010 follow-up regression guard)")

AC-4: no regression to the full gateway test suite.
TEST: services/gateway (full suite) — see outputs/test-results.txt

## Verification

- `tsc --noEmit` clean.
- Targeted suite: 61/61 tests passing, 34/34 snapshots (1 updated).
- Full gateway suite: see outputs/test-results.txt.
- **Live re-verification pending this deploy** — the next real signal is
  re-running the same authenticated `lang:'sr'` batch against staging once
  this merges/deploys and confirming a success rate consistent with this
  bridge's other observed baselines (not 2/11), with genuine Serbian
  speech and no `upstream_ws_close` 1007.
