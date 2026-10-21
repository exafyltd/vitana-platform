# VTID-03704 — ORB voice: not on Nova means Polly, one female voice per language

Evidence pack for the explicit product directive: "Everything which is not
available on Nova has to be redirected to Poly AWS... Serbian stays with Nova.
Everything else is redirected to Polly AWS. now fix that pre login and post
login have the same voices. we want for every language a female voice."

Three reported symptoms, two distinct root causes:

1. **Polish and Portuguese answered in English.** `pl` was never a Nova
   language and reached Nova only because `upstream-provider-selector.ts`
   skips the language gate when `VERTEX_LIVE_UNAVAILABLE=true` (the
   deliberate VTID-03649 tradeoff). `pt` *was* admitted to Nova under
   VTID-03672 on the strength of Bedrock accepting its voice ids, while that
   VTID's own note recorded that end-to-end Portuguese generation had never
   been verified. A live session then answered a `pt` user in English.

2. **German sounded different before and after sign-in.** `NOVA_VOICES` was
   `{ feminine, masculine }` per language with `MASCULINE_PERSONAS`
   (`devon`, `atlas`) selecting the masculine id. An anonymous session
   carries no `activePersona`, so it resolved feminine; the same user signed
   in carrying `devon` resolved masculine. Same user, same language,
   different voice across the sign-in boundary — and nothing in the
   telemetry named the cause, because `persona` was not recorded on the
   session and the logged `voice` field is a Gemini-era name that is not
   what Nova speaks with.

---

AC-1 — Every language Nova does not speak routes to the Polly cascade,
except the one Polly cannot voice

TEST: `services/gateway/test/orb/live/voice/voice-routing-policy.test.ts` —
"routes every non-Nova language to the cascade unless Polly cannot voice it"
TEST: same file — "never cascades a language Nova already speaks — speech-to-speech wins"
TEST: same file — "keeps Serbian on Nova and blames Polly, the blocker that is real"
TEST: same file — "leaves no language with no route at all"
Output: `outputs/voice-suite.txt`

`pt` is removed from `NOVA_SONIC_SUPPORTED_LANGUAGES`, leaving
`en de fr es` on Nova. `ar pl pt ru zh` are cascade-eligible. `sr` is
refused by the cascade with reason `no_polly_voice` — Polly has no Serbian
voice in any engine (verified against the live API: 106 voices, 42 language
codes, no `sr`/`hr`/`bs`/`sh`) — so Serbian stays on Nova with the
documented substitute voice rather than being routed somewhere that also
fails.

Asserted as an invariant over the language *sets*, not per-language
literals, so adding a language to Nova, Transcribe or Polly keeps the rule
true without anyone remembering to edit a constant here.

AC-2 — The voice is identical before and after sign-in, in every language

`MASCULINE_PERSONAS` is deleted and the pair-shaped table is flattened to
one id per language. The persona still drives system instruction, tone and
tools; it no longer picks the vocal cords. The pair table was removed rather
than left half-read — keeping `masculine` keys that nothing resolves would
be a mechanism that looks live and cannot fire.

TEST: `voice-routing-policy.test.ts` — "resolves the same voice for every
persona, in every Nova language"
TEST: same file — "resolves the same voice with no persona at all — the
anonymous case" (asserts anonymous === signed-in directly, i.e. the reported
bug stated as code)
TEST: same file — "never resolves one of the retired masculine voice ids"
TEST: `services/gateway/test/orb/live/voice/nova-sonic-voice.test.ts` —
persona-independence across `en de fr es`
Output: `outputs/voice-suite.txt`

AC-3 — Every language resolves a female voice

`en`/`de` → `tina`, `fr` → `ambre`, `es` → `lupe`, `pt` → `carolina`. The
retired masculine ids (`lennart`, `florian`, `carlos`, `leo`) can no longer
be returned for any language/persona combination. `ru pl ar zh sr` have no
Nova voice published at all and take `NOVA_SONIC_FALLBACK_VOICE` (`tina`,
also female), which is *reported* via `resolveNovaSonicVoiceOrFallback`
rather than silently substituted.

TEST: `voice-routing-policy.test.ts` — "never resolves one of the retired
masculine voice ids"
TEST: `services/gateway/test/orb/live/voice/nova-sonic-voice-fallback.test.ts`
— "reports fallback=true for every language with no native Nova voice"
Output: `outputs/voice-suite.txt`

AC-4 — Rerouting a language must not change how it SOUNDS

TEST: `voice-routing-policy.test.ts` — "keeps a real Nova voice for a
cascade-routed language Nova can still voice"
TEST: same file — "only reports a substitution when Nova genuinely has no voice"
TEST: `nova-sonic-voice.test.ts` — "keeps carolina for pt — the cascade gate
is inert until IAM lands"
TEST: same file — "never substitutes a German voice for Portuguese"
Output: `outputs/voice-suite.txt`

**This is the defect the first draft of this VTID shipped, caught before
merge.** Removing `pt` from the routing list also emptied its voice entry,
because `resolveNovaSonicVoice()` gated on `isNovaSonicLanguageSupported()`
— the *routing* list. Routing and voice answer two different questions and
must not share a guard.

`tryCascadeRescue()` (`upstream-provider-selector.ts`) returns null unless
`ORB_CASCADED_VOICE_ENABLED` is exactly `'true'`, and control then falls
through to `nova_forced_vertex_unavailable`. So until the cascade's IAM is
granted, every `pt` session still transits Nova — and would have been handed
`tina`, a **German** voice reading Brazilian Portuguese. Strictly worse than
the `carolina` it had before, i.e. a regression introduced by the fix, and
invisible to any test that only checked routing.

The voice table now covers every language Nova may be forced to carry; the
routing list still decides where sessions go.

AC-5 — The AC-4 guard is real, not merely green

Mutation-verified rather than asserted: removing `pt: 'carolina'` from
`NOVA_VOICES` turns exactly the four AC-4 tests red, and restoring it
returns the suite to 54/54.

TEST: `outputs/mutation-check.txt` — 4 failed / 50 passed under mutation,
54 passed restored.
Output: `outputs/mutation-check.txt`

AC-6 — Session telemetry can answer "which voice did this user hear?"

TEST: `services/gateway/test/orb/routes/session-start-voice-telemetry.test.ts`
— "records the Nova voice that actually speaks"
TEST: same file — "records whether the language is on Nova at all"
TEST: same file — "resolves the Nova voice through the fallback-REPORTING
resolver" (a bare `??` here would reintroduce the VTID-03578/03682 silence)
TEST: same file — "keeps the legacy live-api voice field rather than silently
replacing it"
Output: `outputs/voice-suite.txt`

`vtid.live.session.start` logged only `voice: getLiveApiVoice(lang)` — a
Gemini-era name Nova cannot use, resolved on a separate path from what
actually speaks, and identical for anonymous and authenticated sessions. It
therefore could not explain a difference the user could plainly hear. Now
also recorded: `nova_voice` (what Nova actually speaks with) and
`nova_language_supported` (whether the language is on Nova at all).

OASIS_PROOF: `services/gateway/src/routes/orb-live.ts` — the
`emitLiveSessionEvent('vtid.live.session.start', { … })` payload gains the
two fields above. This is an additive payload change to an existing event:
no new event type, no new emit site, no change to emission conditions or to
any existing field. **Not confirmed against a live event** — this session
has no AWS CLI (`aws: command not found`, verified) and writing to
production to generate one is forbidden by CLAUDE.md's absolute rule. First
live confirmation is the next staging session's `oasis_events` row.

AC-7 — Existing suites that encoded the old behaviour were inverted, not deleted

`nova-sonic-voice.test.ts` (persona split, pt-on-Nova),
`nova-sonic-voice-fallback.test.ts` (pt in the fallback list),
`cascaded-voice.test.ts` (cascade language set), and
`nova-sonic-config.test.ts` (health-payload languages) all previously
asserted the old behaviour as correct. Each was rewritten to assert the new
contract, so a regression fails loudly instead of silently passing.

TEST: `npx jest test/orb/live/voice/ test/orb/routes/session-start-voice-telemetry.test.ts`
— 6 suites, 58/58 passing.
Output: `outputs/voice-suite.txt`

AC-8 — Full regression suite is clean

TEST: `npx jest test/orb` — 126/126 suites, 1724/1730 tests passing (6
pre-existing todo), 0 failures.
Output: `outputs/full-orb-suite.txt`

AC-9 — Type-checks clean

TEST: `npx tsc --noEmit` — no output, exit 0.
Output: `outputs/tsc.txt` (empty — clean)

---

## Verification summary

| Check | Result |
|---|---|
| Targeted voice + telemetry suites | 58/58 passing (6 suites) |
| Full `test/orb` suite | 126/126 suites, 1724/1730 tests, 0 failures |
| `tsc --noEmit` | clean |
| AC-4 mutation check | 4 red under mutation, 54/54 restored |
| Path-ownership guard (local dry run) | APPROVED — all in-remit files match `gateway_backend` |
| Route-mount evidence gate (local dry run) | not required — no route registration added |
| Live traffic confirmation (staging) | **pending — this PR must merge and deploy first** |

## Remaining external step — this change does not take full effect until it is done

The cascade is gated on `ORB_CASCADED_VOICE_ENABLED`, which requires
`transcribe:StartStreamTranscription` and `polly:SynthesizeSpeech` on
`vitana-ecs-task-role`.

**Order matters** (CLAUDE.md IF-THEN rule 31): grant and verify the IAM
**first**, then flip the flag. Enabling first does not fail loudly — it
fails per turn, the same silent-degradation shape as the Bedrock
`not_configured` case and the VTID-03665 Polly-permission gap.

Until that grant lands, `ar pl ru zh` keep their current Nova-forced path
and `pt` keeps `carolina` (AC-4). Nothing regresses; the routing rules are
correct in code and become audible when the flag flips.

## Known limitation carried forward

Serbian still has no cloud voice from either provider — Nova publishes none
and Polly has none in any engine. It stays on Nova with the `tina`
substitution, which is now reported rather than silent. Closing that gap
needs a third TTS provider and is a product decision, not a bug in this
path.
