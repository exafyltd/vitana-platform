# VTID-04742 — Vitana says Sie instead of du

The owner reported it on 2026-09-29. Read from `oasis_events`: German voice
turns on production and staging switched between du and Sie from 26 to 29
September. Examples:

- "Guten Tag, Dragan. Wir haben zuletzt über Ihre gespeicherten Informationen
  gesprochen. Möchten Sie, dass ich Ihnen eine Übersicht zeige …"
  (production, 12:24)
- "Leider kann ich keine relevanten Details für Ihre Frage finden." This is
  Nova putting the English tool result "No relevant … found for this query"
  into German.
- The pre-login greeter: "Ich bin Vitana, Ihre persönliche
  Gesundheitsbegleiterin …"

**Cause.** Nobody switched the register. The voice prompts never set one.
Every voice LANGUAGE line only said "Respond ONLY in German". The du rule
existed in `i18n/llm-locale.ts` (`REGISTER_HINTS`), but only the text-LLM
helper `buildLocalizedSystemPrompt` used it. Nova was left to pick a
register itself, and it drifted, especially when it rephrased English tool
output.

**Fix.** `registerRuleForLang(lang)` builds one REGISTER line from
`REGISTER_HINTS`, so there is one table and no second copy. That line now
follows the LANGUAGE line in:

- the live voice instruction;
- the pre-login Maxina presenter;
- the specialist language lock;
- both guided-topic GUIDE MODE blocks;
- both journey-guide GUIDE MODE blocks;
- the text-path language directive (`buildLanguageDirective`), plus the
  memory-derived one;
- the `set_language` tool result.

The rule states the register (du, NOT Sie) and that it applies to
greetings, answers and rephrased tool results. English and unknown
languages get no line.

The prompt snapshots (VTID-04542 payload identity, instruction
characterization) were re-recorded on purpose. The only diff is the added
REGISTER line: +228–249 bytes per voice instruction.

## Acceptance

AC-1: every supported language with an informal register gets its REGISTER line; English and unknown languages get none.
TEST: services/gateway/test/i18n/vtid-04742-voice-register-rule.test.ts

AC-2: the live voice instruction carries the du rule right after LANGUAGE for German, and the text and specialist directives carry it too.
TEST: services/gateway/test/i18n/vtid-04742-voice-register-rule.test.ts

AC-2b: the guided-topic and journey-guide blocks carry it in every language branch, German included; the rule has no quote marks (VTID-03674: quoted exemplars trip Nova's filter).
TEST: services/gateway/test/orb/live/instruction/vtid-04742-guided-register-instruction.test.ts

AC-3: the voice payload snapshots differ only by the REGISTER line.
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

AC-4 (live, staging): German voice turns stop using Sie/Ihr/Ihnen.
TEST: scripts/memory-verification/run-live.mjs
