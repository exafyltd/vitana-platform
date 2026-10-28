# VTID-04014 — VTID-04010's fix broke the Vertex Serbian bridge (1007 close)

## Reported

Self-discovered while re-verifying VTID-04010 (merged as `99f4731`, auto-deployed
to staging) per the platform owner's own instruction to confirm the post-login
Serbian fix actually works after deploy. Re-running the exact authenticated
`lang:'sr'` trial against staging found the Vertex bridge now closes with
`upstream_ws_close code:1007 reason:"Request contains an invalid argument."`
on every single trial (6/6, both the plain re-verification run and the
authenticated-account run), right after `greeting_sent` and before any audio
completes. A direct `oasis_events` query confirmed this close signature has
**zero occurrences anywhere in the prior 7 days** — it started at the exact
minute the new commit rolled out (20:07:34 UTC) and has not stopped since.

## Root cause

VTID-04010's fix changed the `safe_fast_proactive` rung's directive from:

> Say exactly: "\<line\>" — speak it verbatim as audio, as ONE greeting. Do
> NOT add, paraphrase, or split it.

to:

> Translate the following into natural, fluent \<lang\> and speak it as ONE
> greeting, entirely in \<lang\> — do not leave any part of it in English:
> "\<line\>" Keep the concrete details (names, titles, numbers) and the same
> proposal; do not paraphrase them away. Do NOT add a question at the end or
> split it into multiple turns.

This reintroduced the exact anti-pattern the `override_v2` rung (immediately
above this one in the same file) had already identified and fixed in an
earlier VTID: **quoting a block of text and instructing the model to
preserve/translate it "verbatim"/"do not leave any part... do not
paraphrase"** reads as a literal-recitation directive. `override_v2`'s own
comment records this as "the shape [a] guardrail treats as injection-like",
previously observed breaking Nova. This VTID's live measurement confirms the
same shape also breaks Vertex's Gemini Live API — a close signature and 100%
failure rate that did not exist before this exact directive text shipped.

## Fix

Rewrote the `safe_fast_proactive` directive to use the SAME safe pattern
`override_v2` already uses successfully in production: treat the pre-composed
English line as a **lead to compose freely from**, not a quoted string to
recite or translate literally.

```
Open the conversation from this prepared lead (written in English for your
reference): "<line>"
Speak entirely in <lang> — use no English words. Keep every concrete fact
from the lead (names, titles, numbers) and the same single proposal exactly
as given, but compose the wording yourself in <lang>; do not recite the lead
word for word and do not translate it literally. Then stop — do not add a
question beyond the proposal already in the lead, and do not split it into
multiple turns.
```

The instruction to NOT recite/translate literally (rather than an instruction
TO translate/preserve verbatim) is the deliberate inversion that avoids the
guardrail-injection shape.

## Acceptance Criteria

AC-1: the `safe_fast_proactive` rung's directive no longer contains any
"translate the following"/"verbatim"/"do not leave any part of it in
English"/"do not paraphrase them away" phrasing.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  ("rung 4: safe_fast_proactive (pre-fetched proactive line)")

AC-2: the directive correctly names the real target language (Serbian) using
the safe "lead to compose from" framing, not the translate framing.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  ("rung 4: safe_fast_proactive names the real target language (Serbian), not
  just German/English")

AC-3: regression guard — a proactive line containing an embedded quoted title
(the exact shape of the reported live failure) still produces the safe
directive shape, never the verbatim/translate shape.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  ("rung 4: safe_fast_proactive never instructs literal recitation/translation
  of the lead (VTID-04010 follow-up regression guard)")

AC-4: no regression to the full gateway test suite.
TEST: services/gateway (full suite) — see outputs/test-results.txt

## Verification

- `tsc --noEmit` clean.
- Targeted suites (compute-greeting-decision.golden, conversation-flow.contract,
  login-briefing): 3/3 suites, 116/116 tests passing, 35/35 snapshots passing.
- Full gateway suite: see outputs/test-results.txt.
- **Live re-verification pending this deploy** — the next real signal is
  re-running the exact authenticated `lang:'sr'` trial against staging once
  this merges/deploys and confirming `upstream_ws_close` no longer fires and
  genuine Serbian audio/transcript is produced (this is the same trial that
  caught the regression in the first place).
