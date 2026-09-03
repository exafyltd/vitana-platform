# VTID-03718 — Acceptance

## Summary

Reported live: Polish and Portuguese ORB sessions spoke English, with a
correct Portuguese/Polish voice accent. The accent being right while the
content was wrong pointed at a language-CONTENT bug, not a voice-selection
or audio-decode bug.

Root cause, found by reading `compute-greeting-decision.ts`'s
`buildLegacyGreetingPrompt()`: the `anonPrompts` table — the instruction
sent to the model for the anonymous landing-page intro greeting (the exact
code path hit by anonymous visitors on `preview-aws.vitanaland.com`,
confirmed via live production telemetry, `oasis_events`, read-only query) —
had entries for `en de fr es ar zh ru sr` but was missing `pt` and `pl`
entirely. `anonPrompts[ctx.lang] || anonPrompts.en` silently fell back to
the English instruction for those two languages. Polly voice resolution is
a fully separate table and was never affected, which is why the accent was
always correct.

Same defect shape as VTID-03644 (pt/pl missing from a different
per-language wrapper map in this same file) — that instance was fixed,
this sibling table was not.

## Acceptance Criteria

AC-1: The `anonPrompts` table now has `pt` (Brazilian Portuguese) and `pl`
(Polish) entries, translated to match the existing 8-language pattern —
neither language falls through to `anonPrompts.en` any more.
TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
  — new `test.each` block "legacy default: anonymous intro speech is never
  the English fallback for lang=%s", covering all 10 supported languages;
  asserts every non-English language's directive differs from the English
  one. Fails without the fix (pt/pl would equal the English directive),
  passes with it. See outputs/golden-test.txt.

AC-2: No regression to the other 8 already-correct languages or any other
rung in the greeting decision ladder.
TEST: full `test/services/conversation/` tree — 11 suites, 220 tests,
  34 snapshots, all passing (only the 2 new pt/pl assertions added; every
  pre-existing snapshot unchanged). See commands.log.

AC-3: The service still type-checks and builds cleanly.
TEST: `npx tsc --noEmit` (clean) and `npm run build` (exit 0). See
  outputs/vtid03718-tsc.txt, outputs/vtid03718-build.txt.

AC-4: The ORB language-routing decision itself (which provider a language
is sent to) was already correct for pt/pl before this fix and remains so —
this fix is scoped to greeting CONTENT, not routing.
TEST: `ORB_CASCADED_VOICE_ENABLED=true node scripts/verify-language-routing.js`
  (VTID-03717) — pt/pl both report `DECIDED PROVIDER: cascaded`, no
  `<<< PROBLEM` line for either. Only the pre-existing, documented `sr` gap
  (no Polly voice) is flagged. See outputs/verify-language-routing.txt.

## Not yet independently confirmed

This session cannot trigger a live authenticated or anonymous ORB voice
session itself and listen to the result — vitana-v1's CLAUDE.md absolute
rule forbids any write to the shared production Supabase project (which
staging also writes to) on any host, and an anonymous session still writes
session/telemetry records. The fix is verified at the source/test level:
the exact table that produced the English fallback now has the missing
entries, pinned by a test that fails without them. The next real anonymous
Polish or Portuguese visit to the intro page is the first live
confirmation.

OASIS_IMPACT: no — this is a prompt-content fix with no task-lifecycle,
governance, or event-emission surface touched.
