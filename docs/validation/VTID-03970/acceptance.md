# VTID-03970 — Fish Audio TTS fallback for Polly-unsupported languages

## Report

Platform owner asked for a new TTS/STT provider to cover languages Amazon
Polly and Nova Sonic cannot, starting with a test-run for Serbian, and
supplied an API key plus a proposed `reference_id`. The proposed voice
turned out to carry explicit sexual content in its own Fish Audio metadata
and was rejected; the real test-run synthesis call was blocked by the
supplied key having no funded API credit (HTTP 402). Both are documented
below with the actual evidence, not glossed over.

**Round 2, same VTID:** the platform owner asked where to manually test
Fish Audio and pointed at the Command Hub's Voice screens, also flagging
that they still mention Vertex. Investigated before touching anything:
`/command-hub/voice/providers/` ("Providers & Voice", the sibling tab in
the same nav section as the three screens named) already has exactly the
provider-picker + text + Preview pattern requested — but its dropdown
never listed Polly or Fish, and `POST /api/v1/voice/preview` rejected
`provider:'fish'` outright. AC-7/AC-8 below cover that fix. The Vertex
labels fixed are scoped to what was actively misleading (see AC-8) — the
underlying `'vertex'` wire value used by `/api/v1/orb/active-provider`
and its resolver is intentionally untouched; that is a much larger,
separate change (confirmed by reading `provider-name.ts`/
`active-provider-resolver.ts`, which document `'vertex'` as the real,
still-used request/DB value for "the gateway transport Nova Sonic now
serves", not a live Google dependency).

## Acceptance Criteria

AC-1 — Fish Audio is wired as a gated fallback inside the existing Polly
TTS seam (`tryPollySynthesis()`), firing only when Polly has no voice for
the language at all — never on a transient Polly error — so every
existing TTS call site (ORB `/tts` route, greeting bridge, reminder
pre-render) benefits without individual changes.

TEST: `outputs/jest-new-tests.txt` — `test/tts/fish-provider.test.ts`
(14 tests: gating on both `TTS_FISH_FALLBACK_ENABLED` and `FISH_API_KEY`,
request shape sent to `POST /v1/tts`, non-2xx/timeout degradation).

AC-2 — Deploying this code changes no runtime behavior: Fish is inert
unless BOTH `TTS_FISH_FALLBACK_ENABLED=true` AND `FISH_API_KEY` are set.
Neither exists in any environment today.

TEST: `outputs/jest-new-tests.txt` — "defaults to disabled — deploying
this file changes nothing" and "returns null without ever calling fetch
when the feature flag is off".

AC-3 — The originally-proposed Serbian voice
(`f8c26ecae994449faf73bcfae844076b`) is never used anywhere in this
codebase, having been found to carry an explicit sexual description and
`sexy`/`intimate`/`breathy` tags in Fish Audio's own metadata. The curated
replacement (`2ad62aaf885e4a14add09fe4a38ffd23`, "Milica - Female
Serbian", published by Fish Audio's own official account) is used
instead.

TEST: `outputs/jest-new-tests.txt` — "resolves Serbian to the curated
official Fish Audio voice, never the flagged NSFW one" (asserts the
resolved `referenceId` is NOT the rejected one).
CURL: `commands.log` — `GET /model/f8c26ecae994449faf73bcfae844076b`
(shows the explicit description/tags) and `GET
/model/2ad62aaf885e4a14add09fe4a38ffd23` (shows the "Fish Official"
author and the assistant-appropriate description).

AC-4 — Amazon Transcribe already has a real streaming language code for
Serbian (`sr-RS`); the cascaded ORB voice pipeline's only actual blocker
for Serbian was the missing Polly TTS voice, not STT.
`evaluateCascadeEligibility('sr')` now resolves `ttsProvider:'fish'` and
`eligible:true` once Fish is configured, while staying byte-for-byte
`no_polly_voice`/ineligible with Fish unconfigured (the default).

TEST: `outputs/jest-new-tests.txt` —
`test/orb/live/upstream/cascaded-voice-fish-fallback.test.ts` (5 tests:
default-off unchanged, requires both flag+key, `sr`→`fish` once both set,
an already-Polly-covered language stays on Polly, an uncovered language
stays ineligible).

AC-5 — A real synthesis call was attempted, as directed, and failed for a
real account reason (no API credit), not a code defect: the request shape
matches Fish's own published API docs exactly.

CURL: `commands.log` — `POST /v1/tts` with the reviewed voice, real
Vitana-style Serbian greeting text, `HTTP_STATUS:402` and Fish's own
error body ("Insufficient API credit — API credit is managed
independently from platform credit").

AC-6 — Zero regressions: every pre-existing test in the gateway suite
still passes unmodified.

TEST: `outputs/jest-full-suite.txt` — full gateway suite, 930/931 suites
(1 pre-existing skip), 15,259/15,294 tests passing (29 pre-existing
skipped, 6 pre-existing todo), 0 failures. `outputs/tsc-noemit.txt` and
`outputs/npm-build.txt` both clean.

AC-7 — The Providers & Voice screen (`/command-hub/voice/providers/`,
`renderVoiceProvidersView()`) can preview Polly and Fish Audio, not just
Google TTS: its dropdown lists both with real labels, `POST
/api/v1/voice/preview` accepts `provider:'fish'` (calling the same
`synthesizeFish()` the live fallback uses — an honest preview, not a
bypass), and `IMPLEMENTED_TTS_PROVIDERS` includes both so neither option
is disabled in the UI or rejected on save.

TEST: `outputs/jest-new-tests.txt` — `test/routes/voice-config.test.ts`
`describe('provider: fish')` (3 tests: 422 not-configured, 422 no-curated-
voice, 200 with real audio bytes + `X-Vitana-Tts-Voice` header) and
`test/services/voice-config.test.ts` (`IMPLEMENTED_TTS_PROVIDERS.has
('polly'|'fish')` both true).

AC-8 — The two actively-misleading Vertex mentions this session found
and fixed, scoped to the Providers & Voice and Nova Sonic Test Bench
screens: the V2V flip button's "Use Vertex (Gemini Live)" label (Vertex/
Gemini Live is permanently dead, GCP decommissioned) and the Nova bench's
Serbian dropdown option, which claimed "expected fallback → vertex" even
though CLAUDE.md §2e has documented since VTID-03649 that the Vertex
fallback is dead — Serbian has no working ORB voice via this pipeline at
all today. Both corrected to name Nova Sonic / the real current gap
instead. `node --check app.js` clean; `scripts/ci/validator-path-guard.cjs
--csp-added-lines` clean on the full diff (no new inline `style=`
introduced — the one pre-existing inline-style line this session had to
edit the text of was extracted to a CSS class instead).

TEST: `outputs/csp-gate.txt` (the real governance-gate CSP check, run
locally against this PR's actual diff, both before the fix — 2
rejections — and after — 0). `outputs/jest-new-tests.txt` covers the
backend surface these UI labels describe; the label wording itself has
no automated test (it is prose, not logic) but was verified by direct
reading against `provider-name.ts`'s own documented semantics.

## Not yet independently verified

**A real Fish Audio synthesis has never succeeded** — the supplied key
has no funded credit. `scripts/tts/verify-fish-voice.ts` is ready to run
once credit exists; until then, the `pcm`-format sample rate
(`FISH_PCM_SAMPLE_RATE_HZ=16_000`, requested but never confirmed back by
a real response) is a documented assumption, not a confirmed fact.

**Not yet provisioned in AWS:** `FISH_API_KEY` does not exist in Secrets
Manager and is not wired into any ECS task definition —
`scripts/aws/setup-fish-audio-secret.sh` is ready for an operator with
AWS access to run. Deliberately not wired into
`AWS-STAGE-DEPLOY-GATEWAY.yml`'s secret-resolution loop in this PR: that
loop hard-fails the entire staging deploy if a listed secret is missing,
and this session had no way to confirm it exists first.

OASIS_PROOF: not applicable — see `OASIS_IMPACT: no` in the PR body. This
change adds a TTS/cascade-eligibility code path; it emits no new OASIS
events and does not alter any existing `oasis_events` emission path.
