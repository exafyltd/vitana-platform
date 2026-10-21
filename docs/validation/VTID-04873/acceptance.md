# Every language reads its own narration (VTID-04873)

Owner report, 2026-10-04: "English TTS talks German." Root cause:
`applyTranslationToSeed` (checklist-service.ts) overlaid the label and the four
explanation fields but never `vitana_voice_script`, and
`buildGuidedTopicSpokenText` prefers the script. All 260 topics carry a German
script, so every non-German Audiobook episode — and every guided-topic tap
narration — sent the German script to that language's Polly voice. The
translation seeder never translated the script either.

AC-1: For every one of the ten translation targets, narration comes from that language's translated script when it exists, otherwise from the fully translated explanation; the German script is never handed on to another language.
TEST: services/gateway/test/vtid-04873-narration-language.test.ts

AC-2: When a topic has no narration in the requested language, the Audiobook route answers 422 narration_not_translated instead of reading German in another language's voice; a 200 states the narration language in X-Audiobook-Narration-Locale.
TEST: services/gateway/test/vtid-04761-audiobook-audio-route.test.ts

AC-3: The ORB guided-topic tap only pre-renders the lesson when its text is in the member's language.
TEST: services/gateway/test/services/assistant-continuation/providers/guided-topic-narration.test.ts

AC-4: The db-i18n seeder translates vitana_voice_script for the journey-checklist surface (Supabase and Aurora adapters), in batches small enough for ~2,000-character scripts.
TEST: services/gateway/test/vtid-04873-narration-language.test.ts ("the seeder translates the narration script")
TEST: services/gateway/test/db-i18n/db-i18n.test.ts

AC-5: On the deployed staging gateway, each of the ten voiced languages returns audio whose narration language equals the requested language, and Serbian is refused (no voice yet).
TEST: e2e/staging/vtid-04873-narration-language.staging.spec.ts (STAGING-VERIFY)

## Routes

ROUTE_MOUNT: services/gateway/src/routes/guided-journey.ts, mounted at /api/v1/journey (unchanged). No route added; GET /audiobook/topics/:topicId/audio gains a 422 narration_not_translated answer and the X-Audiobook-Narration-Locale header.

FINAL_URL: /api/v1/journey/audiobook/topics/{topicId}/audio?lang={locale}

CURL_PROOF: in-process HTTP against the mounted router (supertest), outputs/tests.txt — "422 narration_not_translated — German text is never read in another language's voice" and "200 audio/mpeg, private cache, in the requested language" (header asserted). STAGING-VERIFY probes the deployed route (anonymous → 401, signed-in per language → narration locale).

## OASIS

No new OASIS event.

## Data follow-up

After merge, I18N-DB-SEED (journey-checklist, all locales, apply) translates vitana_voice_script for all 260 topics into the ten targets. Until then every language narrates its own fully translated explanation (all 2,600 target rows have all four explanation fields, checked 2026-10-04).
