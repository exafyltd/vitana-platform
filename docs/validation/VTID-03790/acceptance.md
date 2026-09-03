# VTID-03790 — Fix nested guillemet/straight-quote spoken text in guided-topic narration prompts

## Report

VTID-03787 shipped diagnostic instrumentation (`nova_instruction_debug_dump`)
that emits the literal Nova system-instruction text for every guided-topic
session. This VTID used that instrumentation for the first time: two real
live sessions were run against staging (one guided-topic tap, one ordinary
open) and their literal `novaSystemInstruction` text was pulled from
`oasis_events` and diffed directly.

The diff surfaced a concrete difference beyond every pattern VTID-03785/
03786 already removed: the guided-only "SPOKEN FIRST UTTERANCE — REQUIRED
VERBATIM" block (built by `buildVertexWakeBriefBlock` in
`live-session-controller.ts`, which wraps whatever line it's given inside an
outer straight-quote `"${safe}"` template) carried a doubly-nested quotation
for guided-topic sessions — e.g.:

```
"So, das war „Was ist Vitanaland". Hast du Fragen dazu, oder sollen wir
direkt gemeinsam loslegen?"
```

— German guillemet quotes (`„...“`) around the dynamic topic title, nested
inside the wrapper's own outer straight quotes. The GUIDE-MODUS block that
follows (turns 2+, from `guided-topic-narration-prompt.ts`) repeated the
same pattern around `practice_target` and around the short exemplar
response words the model is told to recognize (`„ja“`, `„mach das“`,
`„okay“`). The English branches used the same shape with plain straight
quotes instead of guillemets — once wrapped by the same outer
`"${safe}"` template, English nests the identical ASCII quote character
inside itself, which is structurally the same defect, not merely a
cosmetic difference.

This matches a pattern this codebase has already independently confirmed
trips Nova's content filter: persona-voiced quoted dialogue/exemplar text.
`nova-instruction-sanitizer.ts` already had to strip a similar construct out
of the IDENTITY LOCK block, and the 2026-08-20 changelog entry for the
`day_close` rung records the same finding (`buildDayCloseOpenerLine` was
rewritten specifically to remove "quoted exemplar dialogue"). Neither
VTID-03785 nor VTID-03786 touched this, because both treated it as static
prompt scaffolding; this content is dynamic per-session data (the topic
title, the practice target, the authored exemplar words) supplied by
`guided-topic-narration-prompt.ts`, a different file from the one those two
VTIDs edited.

## Fix

Removed every guillemet (`„…“`) and straight-quote (`"…"`) wrapping around
dynamic content in `services/gateway/src/orb/live/instruction/guided-topic-narration-prompt.ts`,
across all four builder functions and both language branches:

- `buildGuidedTopicNarrationOpenerLine` — topic title.
- `buildGuidedTopicSpokenLesson` — topic title (fallback-lesson path, no
  authored `voice_script`).
- `buildGuidedTopicPostNarrationLine` — topic title. This is the function
  whose output is the literal text observed nested inside the "SPOKEN FIRST
  UTTERANCE — REQUIRED VERBATIM" wrapper in the live diff.
- `buildGuidedTopicNarrationBlock` — topic title, practice target, and the
  short exemplar response words (`ja`/`mach das`/`okay` in German,
  `yes`/`sure`/`okay` in English), across both the post-narration
  (`content.narrationAudio` set) and legacy teach branches.

This is a pure de-quoting: spoken/instructional text reads naturally without
quote marks around a proper noun or a short exemplar word (e.g. "Lass uns
über Was ist Vitanaland sprechen" / "Let's talk about Was ist Vitanaland"),
and an instruction referencing a practice target reads fine inside plain
parentheses (`(${content.practice_target})`) without also quoting it. No
information is dropped — the topic title, practice target, and exemplar
words are all still present in the text, just no longer wrapped in a
quotation-mark character of any kind. Deliberately did NOT touch
`buildVertexWakeBriefBlock` itself (the outer wrapper) — it is shared by
every non-guided candidate too and was already de-risked by VTID-03786's
"Rules:" rewrite; the fix targets the INPUT the guided-topic-specific
line-builders supply to it.

**English branches were deliberately included, not left as lower-risk.**
Although English uses only single-level straight quotes locally, the same
outer `"${safe}"` wrapper still produces a nested same-character quote once
applied — structurally the identical defect class, just with `"` doubled
instead of `"` inside `„…“`. Fixing only German and leaving English's
straight-quote nesting in place would have left a live, unverified risk on
the exact same mechanism.

## Acceptance Criteria

AC-1 — None of the four builder functions in
`guided-topic-narration-prompt.ts` wrap the topic title, practice target, or
short exemplar response words in any quotation-mark character (`"`, `„`,
`"`), in either language branch.

TEST: `guided-topic-narration-prompt.test.ts` — new `describe('VTID-03790:
no nested quotation marks around dynamic content (Nova content-filter
fix)')` block, 6 new tests covering all four functions × both `narrationAudio`
branches × both languages. Mutation-verified: reverting the source file to
its pre-fix state fails exactly these 5 assertion-bearing tests (the 6th,
"still names the topic and practice target...", is a meaning-preservation
check that continues to pass either way since it only asserts presence, not
absence, of the substring) while all 21 pre-existing tests in the file
continue to pass unmodified — see `outputs/jest-mutation-prefix-file.txt`
vs `outputs/jest-scoped-fixed.txt`.

AC-2 — The fix preserves meaning: the topic title and practice target are
still present in every builder's output after the quote marks are removed.

TEST: same file, "still names the topic and practice target after the quote
marks are removed (meaning preserved)".

AC-3 — All pre-existing tests in this file (spanning VTID-03650, VTID-03685,
VTID-03686, VTID-03762, VTID-03785, VTID-03786's own regression guards)
continue to pass unmodified — the rewording did not silently break an
earlier VTID's own guard.

TEST: same file, all 21 pre-existing `it()` blocks — see
`outputs/jest-scoped-fixed.txt` (26/26 total incl. the 5 new ones).

AC-4 — `tsc --noEmit` clean.

TEST: `outputs/tsc-noemit.txt`.

AC-5 — Full gateway suite green.

TEST: `outputs/jest-full-suite.txt` — 722/723 suites (1 pre-existing skip),
13538/13573 tests passing (13532 before this VTID's +6 new tests), 0
failures.

## Deliberately NOT attempted

- Did not touch `buildVertexWakeBriefBlock` (`live-session-controller.ts`)
  itself — it is a shared wrapper used by every wake-brief candidate, not
  guided-topic-specific, and was already de-risked by VTID-03786. The
  defect lived in what guided-topic-narration-prompt.ts fed INTO it, not in
  the wrapper.
- Did not attempt to reintroduce quoting via a different punctuation
  convention (e.g. em-dash framing, colons) beyond what was needed for
  readability in two sentences (`heißt` → `bedeutet` for grammatical flow
  once the surrounding quotes were removed) — the goal was removing the
  quote-mark character class entirely, not finding an equivalent-looking
  substitute that might carry the same risk.
- Did NOT yet re-run the live guided-topic session against staging to
  confirm this closes the Nova content-filter block — that requires this
  fix to actually deploy first. Recorded as the explicit next step, not
  silently treated as done.

## Governance

`command-hub-ownership-guard.js` not touched — changes are a
`services/gateway/src/orb/live/instruction/*.ts` file and its test, outside
`PROTECTED_PATH` scope.

OASIS_IMPACT: no — prompt-text change only, no new event type, no schema
change, no route change.
