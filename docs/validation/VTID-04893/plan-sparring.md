# Plan sparring record — VTID-04893 (Phase 0) and the Audiobook voice plan

- Sparring record: `plan_sparring_sessions.id = 96e42753-2ca3-4223-9df4-e0b3f93642df`
- Final plan hash (sha256 of the text between the plan markers): `610ad44602766ea9b8669fc0ab010b195843c888fb604f75c2b9d7c0b4156852`
- Initial (v1 final) hash: `490062c38cd420324e92c74bc540ef28ef21cf756acfe5f737b1a8aa4e85bb68`
- Partner: plan-sparring-partner agent (Claude Opus 4.6) for v2; a general-purpose stand-in for v1.
- Verdict: CONVERGED (v2, round 2). Owner approval: "Yes approved" in Claude Code session session_01LRqEtGSPKaEEJPnJDjm3ZB, 2026-10-05 (recorded as context; the binding exafy_admin click is pending).
- This VTID is Phase 0 of the plan. Phase 1 (Audiobook voices) gets its own VTID after Phase 0 is merged and proven on staging.

## Version 2 (final)

# Plan: Audiobook voice rebuild (Google for ru/sr, best Polly engine for the other nine)

<!-- plan:begin -->
## Change class
standard (a route, a TTS provider path, Google auth, `tts/polly.ts`, the staging deploy workflow's env block, CLAUDE.md/backend.md; no migration, no LLM routing)

## Owner decisions (fixed, not for re-argument)
- Russian and Serbian Audiobook voices are Google voices. All other nine languages (ar, de, en, es, fr, pl, pt, tr, zh) stay on Amazon Polly. Google is used for no other language.
- Every Vitana voice is female (CLAUDE.md 42a).
- The owner picks one voice per language from the audition page before anything ships. Polly picks (2026-10-05): en Tiffany generative (en-US), de Vicki generative, fr Ambre generative, es Lucia generative (es-ES), pt Camila generative (pt-BR), pl Ola generative. ar Hala neural, zh Zhiyu neural and tr Burcu neural stay as they are. Russian and Serbian Google voices are picked after the staging audition.
- Production cost control is option (a): an approximate per-task daily Google character cap (owner decision 2026-10-05).
- When the 90-day Google credit window ends, the owner reviews the status and either extends with Google or a new provider is wired for Serbian and Russian (owner decision 2026-10-05).

## Problem
- Audiobook narration (`GET /api/v1/journey/audiobook/topics/:id/audio`) renders through `resolvePollyVoice` (`audiobook-episode-audio.ts:61`), the receptionist table. Russian is Tatyana on Polly `standard` (`polly.ts:93`); Serbian has no Polly voice (`polly.ts:77`), so the route answers 422.
- Six Polly languages can use the `generative` engine on a female voice but are pinned to `neural`.
- Google auth on ECS is unproven. Both the gax `TextToSpeechClient` and the `GoogleAuth` in `orb-live.ts` use the same google-auth-library 9.15.1 and the same `external_account` config whose AWS credential source is the EC2 metadata IP. Staging `/orb/debug/tts` fails with `connect EINVAL 169.254.169.254`, and the bridge's own `GoogleAuth` token prewarm fails the same way in CloudWatch: staging `/vitana/gateway` 2026-10-02 09:32 and 10:18 UTC, production `/vitana/gateway-awsdr` 2026-09-28 16:23 UTC (`[VTID-01219] ORB Voice access-token prewarm failed … 169.254.169.254 … EINVAL`). `gcp-adc-bootstrap.ts` writes that same `external_account` file, so ADC is broken on ECS for `GoogleAuth` as well as gax. Production `oasis_events` show some `vertex_*_bridge` sessions with non-zero `audio_out` (sr 212/194, ru 228, last 7 days), but most with zero, and the reason is not established.

## Phase 0 — prove Google auth before any feature code
Phase 0 is its own VTID and PR (a live-voice auth fix, not Audiobook work), done before the Audiobook VTID.
1. Read-only: staging and prod gateway logs for `[VTID-01219] ORB Voice access token prewarmed` vs `prewarm failed`, correlated with bridge sessions' `audio_out` in `oasis_events`.
2. Owner-side GCP checks (the session cannot do them), as a gate before the token-module PR:
   - enable `texttospeech.googleapis.com` on `project-da3eb05a-c86e-47cb-85f`;
   - confirm which AWS principal the workload identity provider and the `roles/iam.workloadIdentityUser` binding trust (the stage workflow comment says the IAM user `claude-code-aws-agent`, the prod comment says the task role). For ECS, bind the role by attribute, e.g. `principalSet://…/attribute.aws_role/arn:aws:sts::472838866351:assumed-role/vitana-ecs-task-role`, since the assumed-role session suffix changes per task.
3. Token module PR (separate VTID): `services/gateway/src/lib/google-access-token.ts` with google-auth-library's `AwsSecurityCredentialsSupplier` on the ECS task-role container credentials (`@aws-sdk/credential-provider-node` added as a direct dependency) and a token cache. `orb-live.ts` uses it only behind its own flag (`GOOGLE_AUTH_AWS_SUPPLIER_ENABLED`); today's `GoogleAuth` path stays the default, so production ru/sr live sessions keep their current path until the new one logs a token on staging. The ORB regression suites run on that PR. The flag is registered in `services/conversation/conversation-flag-registry.ts` (`exact_true`, area voice) with its staging pin, and `conversation-flag-pins.generated.ts` is regenerated. The flag flips on staging, then prod with the owner's yes.
4. The Audiobook VTID (Phase 1) starts only after that token module is merged and staging logs a successful token and a successful `voices:list`.

## Phase 1 — scope (files)
1. NEW `services/gateway/src/services/tts/google-narration.ts`: Google Cloud TTS through the existing `@google-cloud/text-to-speech` client (the codebase's one Google TTS pattern, `voice-config.ts`), constructed with the shared token module's auth client instead of its own ADC lookup (that lookup is what fails on ECS), always on the supplier path (new code, independent of the live-voice flag; a test pins it), MP3 output, an explicit voice name and an explicit `model_name` where the voice family takes one (CLAUDE.md IF-THEN 30). A byte-aware splitter with a 4,500-byte budget on sentence boundaries (Google caps input at 5,000 bytes; Cyrillic is 2 bytes per character, so the 2,800-character Polly splitter would overflow). Chunks are synthesized in order with concurrency 2.
2. Two independent switches and predicates, mirroring the bridge files: `audiobook-google-ru.ts` (`AUDIOBOOK_GOOGLE_RU_ENABLED`, `ru` only) and `audiobook-google-sr.ts` (`AUDIOBOOK_GOOGLE_SR_ENABLED`, `sr` only). Never one widened list.
3. NEW `services/gateway/src/services/guided-journey/audiobook-voices.ts`: the Audiobook-only voice table (provider, voice id, engine or model, language code) for all 11 languages. `audiobook-episode-audio.ts` reads this table instead of calling `resolvePollyVoice`; for the nine Polly languages the entry is passed to `synthesizePolly` through the new `voiceOverride`. The receptionist `POLLY_VOICES` is not changed.
4. `services/gateway/src/services/tts/polly.ts`: optional `voiceOverride {voiceId, engine, languageCode}` on `synthesizePolly`. Every existing caller stays byte-identical, with a test proving it. For generative voices with rate 1.0, send plain text instead of `<prosody>` SSML (confirm SSML support per voice live). An invalid voice/engine pair returns null, so the route answers 422 and never falls back to the receptionist voice.
5. `audiobook-episode-audio.ts`: provider per the Audiobook table; the provider joins the cache key; an in-flight promise map keyed by cache key dedupes concurrent renders; one structured log line per Google render (characters, voice, topic, language). If a language's flag is on but its table entry is not pinned yet, sr answers 422 `narration_unavailable` and ru keeps Polly.
6. `routes/voice-config.ts` (admin-gated `POST /voice/preview`): the existing `provider: 'google_tts'` value, accepted for `ru`/`sr` only on the Audiobook narration path,, plus Polly `voice`/`engine` overrides. NEW admin-gated, read-only `GET /voice/preview/google-voices?lang=ru|sr` that refuses any other language and returns the female voices with `ssmlGender`.
7. `orb/live/voice/persona-voice-gender.ts`: register the two new Polly voices `Tiffany` and `Ambre` (both female in Polly's `DescribeVoices`, eu-central-1) in `POLLY_VOICE_GENDER`; add a `google_tts` catalog keyed by full voice name, with gender from Google's `ssmlGender`; the VTID-04445 test walks the Audiobook table.
8. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`: the two flags and the cap on staging. They gate a pre-rendered narration path, not a live voice session, so they are plain exact-string env checks like `VERTEX_SERBIAN_BRIDGE_ENABLED` and are not added to `services/conversation/conversation-flag-registry.ts` (only Phase 0's `GOOGLE_AUTH_AWS_SUPPLIER_ENABLED` is, since it changes live sessions). Prod gets them later through the `env_overrides` input of `AWS-PROD-DEPLOY-GATEWAY.yml` at PUBLISH, with the owner's yes. The conversation-flag pin generator reads these workflows; its test is run to confirm the new non-registry flags do not trip it.
9. CLAUDE.md banner, IF-THEN rule 27 and `.claude/rules/backend.md` §2e: record this third narrow Google use (Audiobook narration for `ru` and `sr`, two switches, same dedicated project, never `lovable-vitana-vers1`, same 90-day window and its review-then-extend-or-replace decision).
10. Tests: provider selection (ru/sr → Google only when their own flag is on; the other nine → Polly; Google is never chosen for any other language), REST shape and auth header, byte splitter with a long Russian script, dedupe, cache-key separation, 422 on Google failure, Polly override byte-identity, route tests.
11. Staging spec (read-only for data: GET requests that render audio and write nothing to the database; synthesis cost is bounded by the cap and by one topic per language): `x-audiobook-voice-provider` is `google` for ru and sr and `polly` for the other nine; sr returns 200 audio/mpeg in its own language; anonymous 401. Timeout sized from a cold-render measurement taken in Phase 1 through `/voice/preview`.

## Google voice choice
On staging, `GET /voice/preview/google-voices` lists the female `ru-RU` and `sr-RS` voices. Each is rendered through `/voice/preview` and added to the owner's audition page. The owner picks; only then is the table pinned. If `sr-RS` offers only a Standard voice, the owner sees exactly that, with no substitution of a neighbouring language.

## Failure behaviour
If Google fails for ru or sr, the route answers 422 and the player offers Vitana live. Whether Russian should instead fall back to Polly Tatyana (same language, not Google) is an owner decision, asked explicitly before build.

## Cost
Production narration cache is per-task memory (64 MB LRU, `NARRATION_AUDIO_CACHE=memory`), wiped on every deploy and scale-out, so every deploy re-renders on first play. Google characters are tracked from the per-render log line through a CloudWatch Logs metric filter with an alarm, created by a checked-in script under the Audiobook VTID, run with the owner's approval, and recorded in `docs/validation/<VTID>/` (no OASIS summary event: NEVER-rule 10).

Cap (owner's option a): `AUDIOBOOK_GOOGLE_DAILY_CHAR_CAP_PER_TASK` (integer, characters per gateway task per UTC day; unset or 0 means Google narration is off, so the cap must be set deliberately). Enforced in memory per task, reset at 00:00 UTC, wiped on deploy; it is an approximation of a total budget (cap × running tasks) and is labelled as such in the code and docs. A mid-day deploy gives every task a fresh cap, so a deploy day can spend up to about twice the intended budget; this is an accepted residual of option (a), visible in the alarm. Proposed starting value: enough for one full render of both languages per task per day (2 languages × 260 topics × ~2,000 characters ≈ 1,040,000), tuned from the alarm data. When a task reaches the cap, ru and sr answer 422 `narration_unavailable` for the rest of the UTC day, with one log line, never a fallback to another language's voice; cached audio keeps playing. The cap is set on staging in the workflow and on prod through `env_overrides` at PUBLISH.

## 90-day window
The Google project was opened for the Serbian bridge on or just before 2026-09-17 (VTID-04000 allocated that day), so the 90-day window ends around 2026-12-16. The exact start is confirmed from the GCP project's billing page by the owner and recorded in CLAUDE.md with this change. A routine reminder fires around 2026-12-06, about 10 days before it ends, asking the owner to review usage and choose: extend with Google, or wire a new provider for ru and sr. Until a decision lands, the two flags stay as they are; turning them off returns ru to Polly Tatyana and sr to 422.

## Verification
CI unit and route tests; STAGING-VERIFY as above; owner listening pass on the audition page before PUBLISH.

## Out of scope (tracked separately)
- The Phase 0 token module (its own VTID, done first).
- The gax `TextToSpeechClient` callers (reminders, greeting bridge, debug route), unless Phase 0's shared token module makes migrating them trivial (then a separate VTID).
- The live-voice and STT audit beyond the auth fix.
- Publishing the 250 unpublished German curriculum scripts.
- Durable S3 narration cache (not chosen; option a instead).
<!-- plan:end -->

## History
Version 1 converged after three rounds with a stand-in reviewer (`plan-audiobook-voices.v1.md` holds those rounds and responses). This version 2 adds the owner's 2026-10-05 decisions (Polly picks, cap option a, 90-day review) and is sparred afresh by the plan-sparring-partner agent.


## Planner responses (v2, round 1)
- F1 major — ACCEPTED. Tiffany and Ambre registered in `POLLY_VOICE_GENDER` (item 7).
- F2 major — REJECTED, with evidence. ADC does not work on ECS for `GoogleAuth` either: CloudWatch shows the bridge's own `GoogleAuth` token prewarm failing with `connect EINVAL 169.254.169.254` on staging (`/vitana/gateway`, 2026-10-02 09:32 and 10:18 UTC) and production (`/vitana/gateway-awsdr`, 2026-09-28 16:23 UTC). `gcp-adc-bootstrap.ts` writes the same `external_account` file whose AWS credential source is the EC2 metadata endpoint ECS does not serve. Phase 0 stays. (The same logs show production FCM push sends failing with the same Google token error; reported to the owner separately, outside this plan.)
- F3 major — ACCEPTED. Switched from raw REST to the existing `@google-cloud/text-to-speech` client, constructed with the shared token module's auth client; the reason (its own ADC lookup is what fails on ECS) is stated.
- F4 minor — ACCEPTED as a documented residual (deploy-day budget can roughly double; visible in the alarm).
- F5 minor — ACCEPTED. Registry path corrected; the audiobook flags are plain env checks and stay out of the conversation registry.
- F6 minor — ACCEPTED. The audiobook table replaces `resolvePollyVoice` in the narration path and feeds `voiceOverride` for Polly languages.
- F7 minor — ACCEPTED. Spec scope stated: GET renders, no database writes, bounded cost.
- Q2 — unknown whether `texttospeech.googleapis.com` is enabled; the owner confirms or enables it as part of the Phase 0 gate.
- Q3 — asked of the owner; pending. The plan's default stays 422 and the build does not start until the owner answers or accepts the default.


## Planner responses (v2, round 2)
- F8 minor — ACCEPTED. Item 6 uses the existing `google_tts` provider value.
- Q1 — the build proceeds with the 422 default; a Russian fallback to Polly Tatyana is a one-entry change added later if the owner asks.

## Verdict (v2)
CONVERGED after round 2 with the plan-sparring-partner agent (Claude Opus 4.6). Round 1: 3 majors (F1 accepted, F2 rejected with CloudWatch evidence and acknowledged by the partner, F3 accepted) and 4 minors (accepted). Round 2: all closed or acknowledged; 1 new minor (F8, accepted). No open or disputed blocker or major.

## Version 1 (superseded)

# Plan: Audiobook voice rebuild (Google for ru/sr, best Polly engine for the other nine)

<!-- plan:begin -->
## Change class
standard (a route, a TTS provider path, Google auth, `tts/polly.ts`, the staging deploy workflow's env block, CLAUDE.md/backend.md; no migration, no LLM routing)

## Owner decisions (fixed, not for re-argument)
- Russian and Serbian Audiobook voices are Google voices. All other nine languages (ar, de, en, es, fr, pl, pt, tr, zh) stay on Amazon Polly. Google is used for no other language.
- Every Vitana voice is female (CLAUDE.md 42a).
- The owner picks one voice per language from the audition page before anything ships.

## Problem
- Audiobook narration (`GET /api/v1/journey/audiobook/topics/:id/audio`) renders through `resolvePollyVoice` (`audiobook-episode-audio.ts:61`), the receptionist table. Russian is Tatyana on Polly `standard` (`polly.ts:93`); Serbian has no Polly voice (`polly.ts:77`), so the route answers 422.
- Six Polly languages can use the `generative` engine on a female voice but are pinned to `neural`.
- Google auth on ECS is unproven. Both the gax `TextToSpeechClient` and the `GoogleAuth` in `orb-live.ts` use the same google-auth-library 9.15.1 and the same `external_account` config whose AWS credential source is the EC2 metadata IP. Staging `/orb/debug/tts` fails with `connect EINVAL 169.254.169.254`. Production `oasis_events` show some `vertex_*_bridge` sessions with non-zero `audio_out` (sr 212/194, ru 228, last 7 days), but most with zero, and the reason is not established.

## Phase 0 — prove Google auth before any feature code
Phase 0 is its own VTID and PR (a live-voice auth fix, not Audiobook work), done before the Audiobook VTID.
1. Read-only: staging and prod gateway logs for `[VTID-01219] ORB Voice access token prewarmed` vs `prewarm failed`, correlated with bridge sessions' `audio_out` in `oasis_events`.
2. Owner-side GCP checks (the session cannot do them), as a gate before the token-module PR:
   - enable `texttospeech.googleapis.com` on `project-da3eb05a-c86e-47cb-85f`;
   - confirm which AWS principal the workload identity provider and the `roles/iam.workloadIdentityUser` binding trust (the stage workflow comment says the IAM user `claude-code-aws-agent`, the prod comment says the task role). For ECS, bind the role by attribute, e.g. `principalSet://…/attribute.aws_role/arn:aws:sts::472838866351:assumed-role/vitana-ecs-task-role`, since the assumed-role session suffix changes per task.
3. Token module PR (separate VTID): `services/gateway/src/lib/google-access-token.ts` with google-auth-library's `AwsSecurityCredentialsSupplier` on the ECS task-role container credentials (`@aws-sdk/credential-provider-node` added as a direct dependency) and a token cache. `orb-live.ts` uses it only behind its own flag (`GOOGLE_AUTH_AWS_SUPPLIER_ENABLED`); today's `GoogleAuth` path stays the default, so production ru/sr live sessions keep their current path until the new one logs a token on staging. The ORB regression suites run on that PR. The flag is registered in `conversation-flag-registry.ts` (`exact_true`, area voice) with its staging pin, and `conversation-flag-pins.generated.ts` is regenerated. The flag flips on staging, then prod with the owner's yes.
4. The Audiobook VTID (Phase 1) starts only after that token module is merged and staging logs a successful token and a successful `voices:list`.

## Phase 1 — scope (files)
1. NEW `services/gateway/src/services/tts/google-narration.ts`: Google Cloud TTS over REST (`v1/text:synthesize`, MP3) with the shared token module's supplier path always (new code, independent of the live-voice flag; a test pins it), an explicit voice name and an explicit `model_name` where the voice family takes one (CLAUDE.md IF-THEN 30). A byte-aware splitter with a 4,500-byte budget on sentence boundaries (Google caps input at 5,000 bytes; Cyrillic is 2 bytes per character, so the 2,800-character Polly splitter would overflow). Chunks are synthesized in order with concurrency 2.
2. Two independent switches and predicates, mirroring the bridge files: `audiobook-google-ru.ts` (`AUDIOBOOK_GOOGLE_RU_ENABLED`, `ru` only) and `audiobook-google-sr.ts` (`AUDIOBOOK_GOOGLE_SR_ENABLED`, `sr` only). Never one widened list.
3. NEW `services/gateway/src/services/guided-journey/audiobook-voices.ts`: the Audiobook-only voice table (provider, voice id, engine or model, language code) for all 11 languages. The receptionist `POLLY_VOICES` is not changed.
4. `services/gateway/src/services/tts/polly.ts`: optional `voiceOverride {voiceId, engine, languageCode}` on `synthesizePolly`. Every existing caller stays byte-identical, with a test proving it. For generative voices with rate 1.0, send plain text instead of `<prosody>` SSML (confirm SSML support per voice live). An invalid voice/engine pair returns null, so the route answers 422 and never falls back to the receptionist voice.
5. `audiobook-episode-audio.ts`: provider per the Audiobook table; the provider joins the cache key; an in-flight promise map keyed by cache key dedupes concurrent renders; one structured log line per Google render (characters, voice, topic, language). If a language's flag is on but its table entry is not pinned yet, sr answers 422 `narration_unavailable` and ru keeps Polly.
6. `routes/voice-config.ts` (admin-gated `POST /voice/preview`): `provider: 'google'` for `ru`/`sr` only, plus Polly `voice`/`engine` overrides. NEW admin-gated, read-only `GET /voice/preview/google-voices?lang=ru|sr` that refuses any other language and returns the female voices with `ssmlGender`.
7. `orb/live/voice/persona-voice-gender.ts`: a new `google_tts` catalog keyed by full voice name, with gender from Google's `ssmlGender`; the VTID-04445 test walks the Audiobook table.
8. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`: the two flags on staging. Prod gets them later through the `env_overrides` input of `AWS-PROD-DEPLOY-GATEWAY.yml` at PUBLISH, with the owner's yes. The conversation-flag pin generator reads these workflows and is checked.
9. CLAUDE.md banner, IF-THEN rule 27 and `.claude/rules/backend.md` §2e: record this third narrow Google use (Audiobook narration for `ru` and `sr`, two switches, same dedicated project, never `lovable-vitana-vers1`, same 90-day window).
10. Tests: provider selection (ru/sr → Google only when their own flag is on; the other nine → Polly; Google is never chosen for any other language), REST shape and auth header, byte splitter with a long Russian script, dedupe, cache-key separation, 422 on Google failure, Polly override byte-identity, route tests.
11. Staging spec: `x-audiobook-voice-provider` is `google` for ru and sr and `polly` for the other nine; sr returns 200 audio/mpeg in its own language; anonymous 401. Timeout sized from a cold-render measurement taken in Phase 1 through `/voice/preview`.

## Google voice choice
On staging, `GET /voice/preview/google-voices` lists the female `ru-RU` and `sr-RS` voices. Each is rendered through `/voice/preview` and added to the owner's audition page. The owner picks; only then is the table pinned. If `sr-RS` offers only a Standard voice, the owner sees exactly that, with no substitution of a neighbouring language.

## Failure behaviour
If Google fails for ru or sr, the route answers 422 and the player offers Vitana live. Whether Russian should instead fall back to Polly Tatyana (same language, not Google) is an owner decision, asked explicitly before build.

## Cost
Production narration cache is per-task memory (64 MB LRU, `NARRATION_AUDIO_CACHE=memory`), wiped on every deploy and scale-out, so every deploy re-renders on first play. Google characters are tracked from the per-render log line through a CloudWatch Logs metric filter with an alarm, created by a checked-in script under the Audiobook VTID, run with the owner's approval, and recorded in `docs/validation/<VTID>/` (no OASIS summary event: NEVER-rule 10). Production enablement is an owner choice between:
- (a) a per-task daily character cap (an approximation: total budget divided by task count, reset at midnight UTC, enforced in memory, wiped on deploy), labelled as approximate; a true shared cap would need a new table and gateway write path and is not proposed;
- (b) waiting for durable S3 narration caching (a separate VTID; the bucket and grant don't exist), with the alarm.

## Verification
CI unit and route tests; STAGING-VERIFY as above; owner listening pass on the audition page before PUBLISH.

## Out of scope (tracked separately)
- The Phase 0 token module (its own VTID, done first).
- The gax `TextToSpeechClient` callers (reminders, greeting bridge, debug route), unless Phase 0's shared token module makes migrating them trivial (then a separate VTID).
- The live-voice and STT audit beyond the auth fix.
- Publishing the 250 unpublished German curriculum scripts.
- Durable S3 narration cache.
<!-- plan:end -->


## Planner responses (round 1)
- F1 blocker — ACCEPTED. Added Phase 0: read-only proof of the token path from logs and `oasis_events`, then one shared `lib/google-access-token.ts` with `AwsSecurityCredentialsSupplier` on ECS container credentials, used by both `orb-live.ts` and narration, merged and proven on staging before feature code. Q1: the only evidence is bridge sessions with non-zero `audio_out` in prod (sr 212/194, ru 228); the cause is unproven, so the fix stands.
- F2 major — ACCEPTED. Two switches and two single-language predicates; CLAUDE.md banner, rule 27 and backend.md §2e amended in the same PR.
- F3 major — ACCEPTED. Cost restated for the memory cache; in-flight dedupe; Google character log and daily OASIS summary; production enablement is an owner choice between a daily character cap and waiting for S3 (S3 is a separate VTID).
- F4 major — ACCEPTED. Byte-aware 4,500-byte splitter with a long-Russian test.
- F5 major — ACCEPTED. Staging workflow edit and the prod `env_overrides` path added; owner-side GCP API enablement listed as a Phase 0 step; change class description updated (still standard).
- F6 major — ACCEPTED. `tts/polly.ts` in scope with an optional override; byte-identity test for existing callers; plain text for generative at rate 1.0; invalid pair → 422, no receptionist fallback.
- F7 minor — ACCEPTED. `google_tts` catalog keyed by full name, gender from `ssmlGender`.
- F8 minor — ACCEPTED. Admin-gated read-only `GET /voice/preview/google-voices?lang=ru|sr`.
- F9 minor — ACCEPTED. Provider header asserted per language; flags on in staging before the suite.
- F10 minor — ACCEPTED. Cold-render timing measured in Phase 0; ordered chunk concurrency 2.
- Q2 — owner decision, will be asked before build (422 vs Tatyana in Russian).
- Q3 — same 90-day window; when it ends the two flags go off, ru returns to Polly and sr to 422 unless the owner decides otherwise. Recorded in CLAUDE.md.
- Q4 — owner choice (cap vs S3), stated in the plan.
- Q5 — voice name and `model_name` are explicit per entry in the Audiobook table; the family (Chirp 3 HD vs Gemini-TTS) is chosen from `voices:list` and the owner's listening.


## Planner responses (round 2)
- F11 major — ACCEPTED. The token module is its own VTID and PR, behind `GOOGLE_AUTH_AWS_SUPPLIER_ENABLED` with today's path as the default, ORB regression suites run on it, and the Audiobook VTID starts only after it is merged and proven on staging.
- F12 major — ACCEPTED. Owner-side GCP gate added: confirm or re-bind the workload identity binding to the ECS task role by attribute; `@aws-sdk/credential-provider-node` becomes a direct dependency.
- F13 major — ACCEPTED. Daily OASIS summary dropped; per-render log line plus CloudWatch metric filter and alarm. Cap option restated honestly as a per-task approximation; a shared cap is not proposed; option (b) S3 plus alarm offered.
- F14 minor — ACCEPTED. Flag on but voice unpinned: sr 422, ru keeps Polly; spec assertion conditional on the pin.


## Planner responses (round 3)
- F15 minor — ACCEPTED. Flag registered with its staging pin; pins regenerated (Phase 0 VTID).
- F16 minor — ACCEPTED. Narration always uses the supplier path; a test pins it.
- F17 minor — ACCEPTED. Metric filter and alarm via a checked-in script under the Audiobook VTID, run with owner approval, recorded in the evidence pack.
- F18 minor — ACCEPTED. Cold-render timing measured in Phase 1 via `/voice/preview`.

## Verdict
CONVERGED after round 3 (no open or disputed blocker or major). Rounds: R1 1 blocker + 5 majors + 4 minors; R2 3 new majors + 1 minor; R3 4 minors. All accepted.
