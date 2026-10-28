# VTID-03742 — Anonymous MAXINA Intro speech: compose fresh, don't recite a fixed script

Follow-up to VTID-03740 (the stuck-on-"speaking" client fix). That fix
made the app recover from a Nova stream dying mid-turn; this VTID targets
*why* the stream was disproportionately likely to die on an anonymous
Serbian session in the first place, following the user's explicit request
to fix the underlying issue "if that will improve the languages and
translations."

## Root cause

`buildAnonymousSystemInstruction` (`orb-live.ts`) built the ~45-second
MAXINA Intro speech as a literal, hand-authored script in exactly two
languages — German and English — wrapped in an explicit "READ THIS SPEECH
VERBATIM — DO NOT SHORTEN, SKIP, OR SUMMARIZE" directive. The language
selection was `lang === 'de' ? germanScript : englishScript`, while a
separate line simultaneously instructed `Respond ONLY in ${languageNames[lang]}`.

For any language other than German — French, Spanish (both natively
supported by Nova!), Arabic, Chinese, Russian, Portuguese, Polish,
Turkish, Serbian — this combination amounts to: "recite this fixed
English text in full, but only in {language}." That is a live
full-recitation-translation demand, reaching Nova completely unsanitized
(the Nova instruction sanitizer only touches a different block). This is
the exact instruction shape VTID-03674 already proved trips Nova's
content filter regardless of length, and the general class of defect
VTID-03650 root-caused: any time a conversational model is asked to
recite a specific pre-authored script rather than compose its own
delivery, compliance becomes a live risk. Serbian is the language most
likely to actually break under it, since it also lacks native Nova
support — but the risky instruction shape reaches every non-German
anonymous visitor, not just Serbian ones.

This also put German and English in soft violation of the standing
"never hardcode a spoken sentence" rule (CLAUDE.md NEVER-rule 41): both
happened to get a *literal finished script* too, just one that already
matched their own spoken language, so it worked in practice without
being compliant in shape.

## Fix

Replaced the two-language literal-script ternary with a single,
language-agnostic block, following the proven pattern already shipped in
`buildGuidedTopicNarrationBlock` (`guided-topic-narration-prompt.ts`):
give the model English-authored **material** (the required talking
points, explicitly labeled "paraphrase and explain naturally, do NOT read
aloud") plus an instruction to compose the delivery fresh, in the
visitor's own language, in the model's own words. Applied uniformly to
every language — German and English included, closing the soft
NEVER-rule-41 gap for them too, not just fixing the other nine.

Every talking point from the original en/de scripts survives as material:
identity intro, Vitanaland/Maxina Community + Mariia Maksina/Let's Dance
origin story, community nature (real events/meetups in Germany/Austria/
Switzerland + the Mallorca event series), member benefits (dance/fitness/
wellness/cooking/meditation/hiking + Vitana as a personal AI companion
with memory + curated soundscapes), the vision statement + free-to-join,
and the closing engagement question.

**Scope, per the investigation:** a single call site
(`buildAnonymousSystemInstruction`, invoked once at `orb-live.ts:7548`,
feeding both the Nova and (dead) Vertex paths identically) — no other
rung, provider, or test references this function's private FIRST MESSAGE
content, confirmed by repo-wide grep before and after the change.

**Not in scope / not claimed:** this cannot be independently verified
against live Nova traffic from this session (no Supabase/`oasis_events`
access) — same honest caveat every fix in this chain carries. What's
verified is that the previously-proven-risky instruction shape (recite
this literal text, but translate it) is now gone from the anonymous-intro
rung entirely, for every language including German/English.

---

AC-1 — the old literal German and English scripts are fully removed, not
just the risky `de`-ternary wrapper around them

TEST: `services/gateway/test/orb/live/characterization/no-hardcoded-spoken-wording.test.ts`
— "the old literal German and English scripts are gone, in full"
Output: outputs/targeted-tests.txt

AC-2 — the anonymous intro now hands the model material to paraphrase,
explicitly labeled as such, not a script to recite — matching the
`buildGuidedTopicNarrationBlock` precedent's proven shape

TEST: `no-hardcoded-spoken-wording.test.ts` — "the anonymous intro now
hands the model material to paraphrase, not a script to recite"
Output: outputs/targeted-tests.txt

AC-3 — the language directive is explicit that the material is English
reference content, not a translation target — the exact distinction whose
absence caused the original live-translation-demand bug

TEST: `no-hardcoded-spoken-wording.test.ts` — "the language directive is
explicit that the material is reference content, not a translation target"
Output: outputs/targeted-tests.txt

AC-4 — every required talking point from the original en/de scripts
survives in the new material block, so no content is silently dropped by
the rewrite

TEST: `no-hardcoded-spoken-wording.test.ts` — "every required talking
point survives as material, not as finished prose"
Output: outputs/targeted-tests.txt

AC-5 — no regression to the existing golden-snapshot greeting-decision
suite (which selects this rung by label, `legacy_default`, not by
content) or to the full gateway suite / type-checking

TEST: `compute-greeting-decision.golden.test.ts` (unmodified, still
57/57 passing — confirms this rung is still correctly selected for
anonymous sessions)
TEST: `npx jest` (full suite)
Output: outputs/full-suite.txt
TEST: `npx tsc --noEmit`
Output: outputs/tsc.txt
