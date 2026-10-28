# VTID-03785 — Guided-topic POST-LESSON block trips Nova's content filter 100% of the time

## Report (verbatim)

> But what's stopping you from making it work in a desired way.
>
> 1. User taps a step/session in My Journey.
> 2. Vitana reliably starts teaching that specific topic.
> 3. Teaching happens
> 4. When teaching ends — The "Well done" drawer appears (it was already
>    built, just never got revealed because the overlay never used to close
>    correctly).

Preceded by a live report (topic T003, "Session 7") of the teaching being
repeated twice and then landing on the "Tap the orb to reconnect" stuck
state — investigated in-conversation and traced to Nova's `nova_validation`
content filter blocking the session, prompting the platform owner's
explicit pushback against treating this as unfixable external flakiness
without actually digging into the data first.

## Investigation — live evidence (not assumed)

Queried `oasis_events` (`inmkhvwdcuyhnxkgfvsb`, production) for the 7 days
prior to this VTID, correlating `nova_validation` blocks to their session's
own guided-topic status via `session_id`:

```
had_narration_bridge=false: 561 sessions, 202 blocked ( 36.0%)
had_narration_bridge=true:  158 sessions, 158 blocked (100.0%)
```

Every single guided-topic-narration session (the Polly pre-recorded lesson
audio successfully delivered, `guided_topic_audio_bridge_sent` fired) that
reached its live conversational turn was blocked by Nova's content filter,
**158 out of 158**, across every topic sampled (T001-T009, T015, T251) —
not a subset, not intermittent. Ordinary (non-guided) sessions show the
already-known, still-unroot-caused ~36% baseline flakiness this whole VTID
chain has documented since VTID-03665 — a real but different number. A
100%-vs-36% split on 158 samples is not noise; it is a deterministic defect
in something specific to the guided-topic-narration code path.

Confirmed via the DB that this isn't about any one topic's own curriculum
content: T003's `title` column is even NULL (the provider correctly falls
back to `display_label`, ruling out a literal "null" string in the
prompt), and per-topic breakdown showed every sampled topic at 100%, not
just T003.

## Root cause

`buildGuidedTopicNarrationBlock`'s POST-LESSON branch (the one that runs on
every narrated guided-topic session, since Polly has been succeeding
100% recently) contains two phrasing patterns that independently match
patterns **already proven** to trip this exact Nova content filter
elsewhere in this codebase, and neither is covered by the existing
defense:

1. **Self-referential voice-denial assertion** — `"you did NOT narrate it
   yourself"` (EN) / `"du hast sie NICHT selbst vorgetragen"` (DE), and the
   parallel `"as if you hadn't already explained it"` / `"als hättest du
   sie noch nicht erklärt"`. This is the same shape as the IDENTITY LOCK
   block's persona-denial list (`"You NEVER: … mimic another persona's
   tone, signature phrases, or voice …"`) that `nova-instruction-
   sanitizer.ts`'s own header comment documents as **measured, by live
   bisect on staging (2026-07-27), to trip this filter on its own** — an
   assertion in the system prompt about what the AI's voice did or did not
   do.
2. **Quoted hypothetical spoken example phrases** — `"What do you want?"` /
   `"How can I help you?"` (EN), `„Was möchtest du?"` / `„Wie kann ich dir
   helfen?"` (DE). This matches the quoted-dialogue-exemplar shape the
   2026-08-20 `day_close` fix (VTID-03646 changelog row) already found and
   removed for the same reason — Nova's filter reacting to persona-voiced
   quoted speech, independent of length.

The `nova-instruction-sanitizer.ts` module only scans for and rewrites the
`=== IDENTITY LOCK ===` marker-delimited block — it has no visibility into
the guided-topic-narration block at all, so neither pattern here was ever
in scope for the existing defense.

## Fix

Reworded both patterns out of the POST-LESSON branch (DE + EN) in
`guided-topic-narration-prompt.ts`, preserving intent:

- `"was just delivered ... and does not need to be repeated"` replaces the
  self-referential "you did NOT narrate it yourself" framing.
- `"Don't re-narrate or summarize the lesson — move straight to follow-up
  questions or the next step"` replaces the "as if you hadn't already
  explained it" framing.
- `"Skip generic opening questions — you already KNOW what this was just
  about"` replaces the quoted `"What do you want?"` / `"How can I help
  you?"` examples.

Also fixed the **legacy** (non-Polly, model-narrates-live) branch's
identical quoted-question bullet — preventively, since that branch
currently sees no live traffic (Polly has succeeded on every sampled
session recently) but carries the exact same pattern and would reproduce
this defect the moment Polly synthesis ever fails for a topic.

## Acceptance Criteria

AC-1 — The POST-LESSON block (DE + EN) no longer contains the
self-referential voice-denial phrasing ("you did NOT narrate it yourself" /
"as if you hadn't already explained it" and German equivalents).

TEST: `guided-topic-narration-prompt.test.ts` — "VTID-03785: does NOT use a
self-referential voice-denial phrase"

AC-2 — The POST-LESSON block (DE + EN) no longer quotes hypothetical
spoken example phrases ("What do you want?" / "How can I help you?" and
German equivalents).

TEST: same file — "VTID-03785: does NOT quote hypothetical spoken example
phrases" (post-narration branch)

AC-3 — The legacy (non-narrated) branch's analogous quoted-question bullet
is fixed the same way, preventively.

TEST: same file — "VTID-03785: does NOT quote hypothetical spoken example
phrases" (legacy branch)

AC-4 — The block still conveys the same instructional intent: don't
re-narrate the lesson, skip generic openers, still names the topic and
practice target, still instructs calling `end_guided_topic_teaching`.

TEST: same file — "tells the model NOT to re-narrate the lesson", "still
names the topic and practice target so follow-up guidance works",
"VTID-03762: instructs calling end_guided_topic_teaching..." (all
pre-existing, unmodified in behavior, updated only where wording literally
changed)

AC-5 — All 12 other pre-existing tests in the same file (raw-script
exclusion, language handling, VTID-03686/03762 follow-up-question and
tool-call instructions) pass unmodified.

TEST: `guided-topic-narration-prompt.test.ts` — full file, 18/18 passing.

AC-6 — `tsc --noEmit` is clean.

TEST: `outputs/tsc-noemit.txt` — exit 0 (empty output).

AC-7 — The fix is mutation-verified twice: reverting the self-referential
voice-denial wording fails exactly 1 test (17 others green); separately
reverting the quoted-question wording fails exactly 1 different test (17
others green). Clean restore confirmed via `diff` after each.

TEST: `commands.log` — mutation testing sections.

AC-8 — The full `test/orb` sweep (191 suites, 3484 tests) and the full
gateway suite are both green.

TEST: `outputs/jest-full-suite.txt`.

## Deliberately NOT attempted

- **No change to the underlying `nova_validation` filter itself** — that
  is Amazon Bedrock's own content-safety classifier, external to this
  codebase. This fix removes two specific, evidenced trigger *patterns*
  from the prompt text; it cannot guarantee the filter never fires for
  any other reason.
- **No change to the ordinary-session baseline (~36%) flakiness** — that
  remains the standing, still-unroot-caused issue named throughout this
  VTID chain since VTID-03665; this VTID's evidence only isolates the
  *additional*, deterministic 64-percentage-point gap specific to the
  guided-topic POST-LESSON block.
- **No change to `nova-instruction-sanitizer.ts`'s scope** — extending it
  to cover the guided-topic block was considered, but the direct fix (
  removing the trigger patterns at the source) is simpler and this block
  has no other content worth preserving verbatim, unlike the IDENTITY LOCK
  block the sanitizer exists to patch around.
- **Not independently confirmed against live traffic.** Same standing
  caveat as every VTID in this chain: this session has no live-browser
  verification path and cannot invoke Nova directly to test the hypothesis
  before shipping. The evidence for this fix is unusually strong (a clean
  100%-vs-36% split on 158 real samples, plus two independently
  already-proven trigger-pattern matches) but the definitive confirmation
  is the next real guided-topic tap on staging/production actually
  completing without a `nova_validation` block. If the block rate does not
  drop after this ships, that is a real, useful negative result — it would
  mean the trigger lives elsewhere in the assembled instruction, not in
  this block, and would need renewed investigation.
