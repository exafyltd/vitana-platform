# VTID-03578 — Polly locale coverage (gateway half)

**Profile:** `gateway_backend`

Part of moving off Google TTS onto Amazon Polly. This PR is the gateway-code
half: a live wrong-language bug in `resolvePollyVoice()`, plus the tests that
would have caught it.

The other half — `TTS_PROVIDER`/`TTS_POLLY_STRICT`/`IMAGE_PROVIDER` as deploy
inputs on `AWS-PROD-DEPLOY-GATEWAY.yml`, the AWS-staging pin, and the CLAUDE.md
corrections — ships separately, because `.github/workflows/` and `CLAUDE.md`
are outside every `VALIDATOR-CHECK` profile allowlist while this PR touches
`services/gateway/src/**`, which is a trigger path. Carrying both would make
this PR unpassable under any profile (exit 22).

---

AC-1 — Portuguese and Polish users get Portuguese and Polish audio, not English

`pt` and `pl` appeared in neither `POLLY_VOICES` nor `POLLY_UNSUPPORTED_LANGS`,
and `resolvePollyVoice()` ended `?? POLLY_VOICES['en']`. Both live release
locales therefore resolved to **Joanna / en-US / neural**: a healthy-looking
result that returns real audio bytes, logs nothing, and reads the user fluent
English. Nothing downstream can detect it — which is the exact failure the
module's own header calls worse than silence, one screen above the line that
caused it.

TEST: `test/tts/polly-provider.test.ts` → "resolves the supported languages
with an explicit engine" (now includes `pt`, `pl`).
Evidence: `outputs/voice-coverage.txt` — `pt → Camila / neural / pt-BR`,
`pl → Ola / neural / pl-PL`.

AC-2 — `pt` is Brazilian, not European

The UI catalog is pt-BR (VTID-03576). Polly's pt-PT voice (Inês) would read
Brazilian text in the European variant — fluent, and wrong in a way no coverage
metric registers, since the row exists either way.

TEST: `test/tts/polly-provider.test.ts` → "speaks Brazilian Portuguese, not
European, for pt". Evidence: `outputs/voice-coverage.txt` — `pt-BR`.

AC-3 — a language outside the table returns null rather than English

The `sr` early-return already expressed the right principle; the `?? en`
fallback quietly exempted every *other* unlisted language from it. Unlisted
languages now return `null` exactly as `sr` does, so the caller's existing
"null means fall back / degrade" contract covers the whole gap instead of one
hand-picked entry of it. After AC-1 this branch is unreachable for any locale
this platform ships, so the change cannot regress a live locale.

TEST: `test/tts/polly-provider.test.ts` → "returns null for a language outside
the table instead of English audio".
Evidence: `outputs/voice-coverage.txt` — `ja`/`nl`/`tr` all NULL.

AC-4 — the coverage assertion is driven by the release-locale list, not the voice table

Iterating `POLLY_VOICES` can only tell you what is present; it can never tell
you what the platform ships and is missing. That asymmetry is precisely why
`pt`/`pl` went unnoticed. The new test enumerates the nine release locales and
requires each to either resolve or be an explicitly declared gap, and pins the
declared-gap set to exactly `['sr']` so it cannot quietly grow into an amnesty
list.

TEST: `test/tts/polly-provider.test.ts` → "covers every release locale, with sr
the one declared gap".

AC-5 — Serbian remains a declared gap, not a silent one

Polly has no Serbian voice in any engine. `sr` is GA. `resolvePollyVoice('sr')`
returns null and the caller falls back to Google, so nothing regresses today —
but this is the one hard blocker on switching Google TTS off entirely, and it
is a product decision rather than a technical one.

TEST: `test/tts/polly-provider.test.ts` → "returns null for Serbian rather than
silently substituting another language" (pre-existing, still passing).

AC-6 — both guards are mutation-verified

A test that passes for the wrong reason is worse than no test. Both new guards
were checked by reintroducing the defect they exist to catch.

TEST: `outputs/mutation-verification.txt` — deleting the `pt` voice row fails 3
tests; restoring `?? POLLY_VOICES['en']` fails 1; the suite returns to 20/20
when reverted.

AC-7 — no behaviour changed for any provider that is actually live

`TTS_PROVIDER` still defaults to `google`, so nothing in this PR alters
production audio. It changes what Polly *would* do once selected.

TEST: `test/tts/polly-provider.test.ts` → "defaults to google when
TTS_PROVIDER is unset — deploying this code flips nothing" (pre-existing).

AC-8 — the suite and the typechecker are clean

TEST: `outputs/tts-suite.txt` — 20/20 passing.
TEST: `outputs/tsc.txt` — `tsc --noEmit` exit 0.

---

VALIDATION_PROFILE: gateway_backend

SCOPE_ALLOWLIST:
- `services/gateway/src/services/tts/polly.ts`
- `services/gateway/test/tts/polly-provider.test.ts`
- `docs/validation/VTID-03578/**`

ACCEPTANCE: AC-1 … AC-8 above, each with a named TEST and captured output
under `outputs/`.

MERGE_PAYLOAD_PREVIEW: two source files (one provider module, one test suite)
plus this evidence pack. No migration, no workflow, no dependency change, no
route change, no config default changed.

OASIS_IMPACT: no
