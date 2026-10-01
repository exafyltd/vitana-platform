# VTID-04724 — a reopened voice conversation answers in German on a Russian session

## Reported

Platform owner, live on production, 2026-09-28:

> "When selecting Russian language, it speaks German with Russian TTS. The
> Russian voice is also like from a desperate old woman with zero energy.
> Terrible"

Two independent faults. This VTID fixes the first. The second is root-caused,
live-re-measured, and **deliberately not fixed here** — see "Not addressed".

## Context: the previous Russian fault is gone

The earlier report (VTID-04198's PR) was Russian being forced onto Nova Sonic,
which has no Russian voice and substituted `tina` — Nova's *German* voice — for
about one word. `ORB_CASCADED_VOICE_ENABLED` has since been turned on in
production. Confirmed live on `/api/v1/orb/nova-sonic/health` (prod commit
`2ae96e05`):

```
"cascade": { "enabled": true, "effective": true,
             "languages": { "ru": "cascade:ru-RU", ... } }
```

So `ru` now runs Transcribe → Bedrock → Polly, and the reported symptom has
changed shape accordingly: full, fluent sentences, correct Russian voice —
wrong *language* in the text.

## What the logs show (read-only, `oasis_events`)

One member, nine `lang:'ru'` sessions inside ten minutes on 2026-09-27, every
one of them `provider:'cascade/polly'`. Cross-referencing each session's
`greeting_sent` diag against its `turn_complete` `output_preview`:

| `wake_opener` | German replies | example output |
|---|---|---|
| `resume_thread` | **4 of 6** | "Soll ich den Media Hub mit Podcasts, Musik und Reels jetzt direkt für dich öffnen?" |
| `safe_fast_proactive` | 0 of 5 | "Добрый день, Мариia! …" |
| `legacy_default` | 0 of 1 | "Добрый день! …" |

`lang` was `ru` on all nine, so this is not the cascade, not Polly, and not the
language tag. It is one greeting rung.

Full query output: `outputs/telemetry-ru-sessions.txt`.

## Root cause

`buildResumeThreadOpenTrigger()` (`compute-greeting-decision.ts`, the
`resume_thread` rung — VTID-04575) carried **no language nudge at all**, while
its entire job is:

> "Continue that conversation from where it stopped … its earlier turns are in
> the conversation history in your instructions."

That history is German for most members, because DE is this platform's source of
truth. So the immediate task instruction ("continue this German thread") beat the
session's own top-level `LANGUAGE: Respond ONLY in Russian`, which sits far
earlier in the instruction. The rungs that *did* carry a language nudge
(`safe_fast_proactive`, `override_v2`) were 0-for-11.

A second instance of the same class, found in the same pass and fixed with it:
`buildResumeDirective()` (`decide-opening.ts`, the `conv_resume` rung) stated the
language as a **bare ISO code** —

```
## LANGUAGE
ru. Speak only in the user's language.
```

— nothing there says "Russian" — and then demonstrated its own phrasing **in
German three times**, to every language: `"ich würde vorschlagen, wir …"`,
`"schau dir deine Matches an"`, `"lass uns einen davon auswählen und eine
gemeinsame Aktivität starten"` — while its closing line claimed "Nothing here is
hardcoded wording". Those are spoken strings in a prompt (NEVER rule 41) and
quoted persona-voiced speech, the shape VTID-04124/VTID-03797 measured as
content-filter-prone on Nova.

## Why the fix is GENERIC and must stay generic

The obvious fix — name the language, "Respond ONLY in Russian" — is a shape this
repo has already measured and **reverted**. Per rung 4's own recorded comment in
`compute-greeting-decision.ts`:

- VTID-04010 follow-up #1 added a translate-this directive → *every* authenticated
  Serbian trial then closed `1007 "Request contains an invalid argument."`, a
  signature with zero occurrences in the prior 7 days.
- VTID-04010 follow-up #2 (VTID-04015) tried `"Speak entirely in ${langName} —
  use no English words"` → still only **2 of 11** trials succeeded.
- The fix was to **drop `langName`/`LOCALE_ENGLISH_NAME` entirely** and match
  `override_v2`, which is 24/24 and never names the language at all, leaving
  language SELECTION to the system prompt's own `Respond ONLY in {language}`.

An earlier cut of this VTID added `Respond ONLY in ${langName}` and was withdrawn
for exactly that reason. Both fixes here therefore say only "the user's own
language for this session", and name the source language (German) purely as the
thing **not** to mirror — precisely how rung 4 names English.

## Acceptance criteria

AC-1 — the `resume_thread` trigger tells the model to speak the session language
even when the history is in another one.
TEST: `services/gateway/test/services/conversation/vtid-04724-resume-directive-language.test.ts`
("tells the model to speak the session language even when the history is another one")

AC-2 — it carries the topic across but not the history's wording.
TEST: same file ("carries the topic across but NOT the history's wording")

AC-3 — it never names a target language, so the reverted VTID-04010/04015 shape
cannot come back.
TEST: same file ("never names a target language — the reverted VTID-04010/04015 shape")

AC-4 — the VTID-04575 continuation contract the rung exists for is intact.
TEST: same file ("keeps the VTID-04575 continuation contract it was built for")

AC-5 — the trigger stays a positive intent: no prohibition stack, no quoted
dialogue (the rung's predecessor was filter-rejected on 44 of 61 reopens).
TEST: same file ("stays a positive intent — no prohibition stack, no quoted dialogue")
TEST: `services/gateway/test/services/conversation/vtid-04575-resume-thread-rung.test.ts`
("the directive is a positive intent: no quoted sentence, no recitation, no prohibition stack")

AC-6 — `buildResumeDirective` no longer states the language as a bare ISO code.
TEST: same file ("no longer states the language as a bare ISO code")

AC-7 — it nudges generically and tells the model not to mirror the German material.
TEST: same file ("nudges generically and tells the model not to mirror the German material")

AC-8 — it names no target language for ANY session language.
TEST: same file ("never names a target language, for ANY session language")

AC-9 — it carries no German sentence it expects every language to imitate.
TEST: same file ("carries no German sentence it expects every language to imitate")

AC-10 — the fix reaches all three same-day resume registers, and the guided-offer
contract is not dropped.
TEST: same file ("applies to all three same-day resume registers, not one of them",
"still guides to a concrete next step — the fix did not drop the offer contract")

## Verification

See `outputs/`. Summary:

- `tsc --noEmit` — clean.
- New suite: 11 tests, all passing.
- **Mutation-verified, both halves independently**: removing the `resume_thread`
  nudge fails 2; restoring the bare ISO code fails 3.
- `vtid-04575-resume-thread-rung.test.ts` (the rung's own suite, which directly
  exercises the changed function): 12/12 passing, including its positive-intent
  guard.
- Conversation suites: 658/658 tests passing.
- 6 golden snapshots re-recorded **deliberately and diffed line by line**, not
  blanket-updated. The diff contains only the four intended edits.

Two process notes, recorded because both were caught by verification rather than
by intent:

1. The first cut rendered "Respond ONLY in German. **Do NOT switch to German.**"
   for a German session — self-contradictory, caught by reading the golden diff
   instead of accepting it. That cut was then withdrawn entirely for the
   VTID-04010 reason above.
2. The branch was restarted from `main` (its prior PR was merged) and the edited
   file was first replayed from the older base, which silently reverted three
   unrelated newer `main` changes to the same file (a system-instruction guard
   line, a "THIS TURN ONLY OFFERS" rule, an EXECUTION rewording). Caught in the
   snapshot diff; the edits were re-applied onto `main`'s real current file and
   the diff re-checked until it contained only this VTID's changes.

## Not verified — stated plainly

- **No live confirmation.** This session cannot place an ORB voice call, and
  CLAUDE.md forbids testing against production. The fix is verified structurally
  against the exact mechanism the production telemetry shows, not observed
  answering a real Russian session.
- **The effect is on model compliance, not a deterministic code path.** Unlike a
  branch fix, this changes what the model is told. The signal to watch is the
  `resume_thread` German rate falling toward its siblings' 0-for-11 — query in
  `outputs/telemetry-ru-sessions.txt` re-run after deploy.
- **n is small** (6 `resume_thread` opens). The honest claim is a clear
  contrast against a 0/11 sibling baseline, not a precise rate.

## Not addressed (deliberately) — the Russian voice quality

Root-caused and **re-measured live today**, not taken from the existing docs.
`DescribeVoices` against `ru-RU` in `eu-central-1`, the region production runs
in (`outputs/polly-ru-voices.txt`):

```
Tatyana   Female   engines=[standard]
Maxim     Male     engines=[standard]
--- any neural/generative RU voice? ---
NONE — standard engine only
```

Production speaks Russian with **Tatyana on Polly's `standard` engine** — its
oldest, flattest engine. Russian is the ONLY language in `POLLY_VOICES` not on
`neural`; every other shipped locale is neural (and six could go `generative`).
"A desperate old woman with zero energy" is an accurate description of that
engine, and it is **not fixable inside Polly** — switching to Maxim only changes
gender, not engine.

Closing it needs a provider decision, which is the platform owner's:

1. **Fish Audio** — multilingual and expressive; the cascade already has a Fish
   backend (`tts-backend.ts`). Blocked on two things: `FISH_API_KEY` is not in
   AWS Secrets Manager (proven live — prod health still reports
   `"sr": "no:no_polly_voice"`, which is only true when Fish is unconfigured),
   and a Russian `reference_id` must be **curated and metadata-verified** first.
   That verification is not optional: the Serbian voice originally proposed for
   this integration carried an explicit sexual description and `sexy`/`intimate`
   tags (see `fish.ts`'s header). Picking one blind for a health assistant would
   repeat exactly that near-miss, and this session has no key to run
   `GET /model/{id}`. So this is raised, not guessed at.
2. **Widen the Vertex Serbian bridge to `ru`** — Gemini Live speaks Russian
   natively in one hop, no cascade turn-shaping. But that bridge is deliberately
   "one language, one flag, one narrow selector gate, not a general reopening"
   (§2e-vertex-serbian-bridge), and it spends the owner's own 90-day GCP credit.
   Their call, not a unilateral one.
3. **Accept Tatyana** for now.

Also flagged, not fixed: the Russian greeting rendered the member's name as
`Мариia` — a half-transliterated Latin/Cyrillic mix of "Mariia". Cosmetic, model
-side, and its own concern.
