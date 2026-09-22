---
paths:
  - services/gateway/src/**
  - services/agents/**
  - services/oasis-operator/**
  - services/oasis-projector/**
  - services/worker-runner/**
  - services/vcaop/**
  - services/vcaop-mcp/**
  - services/erp-bridge/**
  - supabase/migrations/**
---

# Backend reference — vitana-platform

Moved verbatim out of `CLAUDE.md` on 2026-09-22 (pure relocation, section
numbers/content unchanged) so a session that never touches these paths
doesn't force-load provider/services/database/memory reference material.
VTID governance (§4) and the no-production-write posture stay in the root
`CLAUDE.md`, unscoped, because those must apply regardless of which files
a session happens to open in a given turn.

---

## 2. SERVICES ARCHITECTURE

### Deployable Services (AWS ECS — see §1b for exact ECS service/task-def names)
| Service | Source Path | Service Name |
|---------|-------------|----------------|
| Gateway | `services/gateway/` | `gateway` |
| OASIS Operator | `services/oasis-operator/` | `oasis-operator` |
| OASIS Projector | `services/oasis-projector/` | `oasis-projector` |
| Verification Engine | `services/agents/vitana-orchestrator/` | `vitana-verification-engine` |
| Worker Runner | `services/worker-runner/` | `worker-runner` |

### Non-Deployable Services (Libraries/Local)
- `services/agents/` - Agent implementations
- `services/mcp/` - MCP protocol
- `services/mcp-gateway/` - MCP gateway
- `services/deploy-watcher/` - Deploy watcher
- `services/oasis/` - OASIS core
- `services/validators/` - Validators

### Service Path Map
Located at: `config/service-path-map.json`

---

## 2b. LLM ROUTING — BEDROCK PROVIDER (VTID-03403)

> **⭐ STANDING DECISION (VTID-03563): Claude runs on AWS Bedrock, always —
> never the direct Anthropic API.** Not up for re-litigation. Reason: the
> direct Anthropic account has no credit balance, so `provider: 'anthropic'`
> calls fail and the router used to **silently fall back to Google**
> (measured 268 such failures in 14 days before this was caught). Bedrock
> bills to AWS and is unaffected. **Order matters (IF-THEN rule 31):**
> verify `BEDROCK_ROLE_ARN` is set and working BEFORE flipping
> `llm_routing_policy` to `bedrock` — an unconfigured adapter reports
> `not_configured` and the router silently serves the fallback instead,
> reproducing the exact bug this decision exists to end.

`services/gateway/src/services/llm-router.ts` selects a provider per-stage
from the DB-backed `llm_routing_policy` table (Command Hub dropdown), via
`ADAPTERS: Record<LLMProvider, ProviderAdapter>` — `bedrock`, `anthropic`,
`openai`, `vertex`, `deepseek`, `claude_subscription`. **`vertex` is dead
code — GCP billing is off (§1).** A stage pointed at it fails outright
rather than falling back; that's a bug to fix, not tolerate.

- **Region** `eu-central-1` (`AWS_BEDROCK_REGION` → `AWS_REGION` →
  `us-east-1`). **Activation gate** `BEDROCK_ROLE_ARN` — unset means the
  adapter reports `not_configured` and is skipped, same as any provider
  with missing credentials.
- **Model selection** needs a resolved cross-region **inference profile
  ID** (`BEDROCK_MODEL_ID`, else `PROVIDER_FLAGSHIPS.bedrock` in
  `llm-defaults.ts`), not a bare model ID. ID suffix (`-v1:0` or none) is
  **not** a reliable convention — newer profiles drop it, older ones keep
  it; both are valid. Source of truth is `aws bedrock
  list-inference-profiles`, never this file's prose.

**⚠️ `ACTIVE` in the profile listing does NOT mean invokable.** Measured
2026-08-10: of 22 `ACTIVE` Anthropic profiles, only **3** actually invoke:

| Profile | Real invoke |
|---|---|
| `eu.anthropic.claude-sonnet-4-6` | ✅ works |
| `global.anthropic.claude-sonnet-4-6` | ✅ works |
| `eu.anthropic.claude-sonnet-4-5-20250929-v1:0` | ✅ works |
| `eu.anthropic.claude-opus-4-5-20251101-v1:0` | ✅ works — **re-measured 2026-09-13 (VTID-03846):** invoked normally as the `worker` policy primary on staging (29.6s, 3,517 in / 2,768 out tokens). The 2026-08-10 sweep had every Opus profile as unsubscribed; this one is not. |
| Every Haiku profile, every other Opus profile (incl. the task def's `claude-opus-4-7`), `claude-sonnet-5`, `fable-5` | ❌ `AccessDeniedException` (account not subscribed via `aws-marketplace`, not an IAM problem) — as measured 2026-08-10; only the Opus 4.5 row above has been re-measured since, so re-invoke before trusting this row for any other profile |
| `claude-3-7-sonnet`, `claude-3-5-sonnet`, `claude-sonnet-4-20250514` | ❌ end-of-life / not found |

An unsubscribed model doesn't fail loudly — it serves 100% fallback forever
while the policy table still reads `bedrock`. **Before pointing a stage at
a Bedrock model, invoke it for real, not just list it:**
```bash
python3 -c "import json;open('/tmp/b.json','w').write(json.dumps({'anthropic_version':'bedrock-2023-05-31','max_tokens':16,'messages':[{'role':'user','content':'hi'}]}))"
aws bedrock-runtime invoke-model --region eu-central-1 \
  --model-id eu.anthropic.claude-sonnet-4-6 --body fileb:///tmp/b.json /tmp/o.json
```
(`--cli-binary-format` is AWS CLI v2 only; v1 omits it.) Note: the live
task def's `BEDROCK_MODEL_ID` (`eu.anthropic.claude-opus-4-7`) is one of
the unsubscribed ids — harmless (it's only the dropdown default) but
misleading if picked from the UI.

Vision + forced tool calling are supported (VTID-03496) — `image`/`images`
become Anthropic content blocks, `tools`/`forceTool` become `tools` +
`tool_choice`, same wire shape as `anthropicAdapter`. Implementation:
`services/gateway/src/providers/bedrock.ts` (`invokeBedrock()`) does the
`BedrockRuntimeClient.send()` call; `bedrockAdapter` in `llm-router.ts`
adapts it to `ProviderAdapter`. `BEDROCK_ROLE_ARN`/region are read at call
time, so a task-def env change takes effect without a restart.

---

## 2c. TTS — AMAZON POLLY PROVIDER (VTID-03495)

Gateway TTS routes through `services/gateway/src/services/tts/tts-provider.ts`,
selected by `TTS_PROVIDER=google|polly`. **⚠️ Code's internal fallback when
unset is still `google` — GCP is off, so that default is a hard failure,
not safe.** Production/staging task defs must set `TTS_PROVIDER=polly` and
`TTS_POLLY_STRICT=true` explicitly (verify on the live ECS task defs).
Without strict mode, an unservable request tries to fall back to Google —
which no longer exists — instead of failing fast.

| Call site | Format | Behaviour |
|---|---|---|
| ORB greeting bridge, reminder pre-render, ORB `/tts` route | PCM/MP3 | Polly-first when configured |
| Admin voice preview (`voice-config.ts`) | MP3 | Explicit `provider:'polly'` param only, ignores `TTS_PROVIDER` |
| Cloud TTS debug route | MP3 | Google only, on purpose — it's a diagnostic |

**Three Polly gotchas that will produce a plausible-but-wrong result if missed:**
1. **No Serbian voice, any engine** — `resolvePollyVoice('sr')` returns null.
   With Google gone too, **Serbian TTS is currently silent/broken in
   production** until a third provider or an accepted product gap.
2. **PCM is 8kHz/16kHz only, never 24kHz** — `synthesizeGreetingBridgeAudioPcm()`
   returns `{audioB64, sampleRateHz}`; hardcoding 24kHz plays audio 1.5× fast.
3. **No `speakingRate` field** — rate becomes SSML `<prosody rate="N%">`,
   forcing `TextType:'ssml'` + XML-escaping (plain text only at rate 1.0).

Locale coverage: `de en es fr pt pl ru zh ar` all resolve; `pt` is pinned to
pt-BR (Camila); `sr` is the only unresolved locale (returns null, not a
wrong-language voice).

### ✅ VERIFIED against the live API 2026-08-20 (BOOTSTRAP-POLLY-NARRATION-CACHE)

This table had carried "not verified against the live Polly API" since
VTID-03495 — the building session had no AWS credentials. It has now been
checked with real `DescribeVoices` + `SynthesizeSpeech` calls in
`eu-central-1`. Run `scripts/tts/verify-polly-voices.ts` to re-check.

- **Serbian is genuinely absent — confirmed, not assumed.** 106 voices, 42
  language codes, nothing matching `sr`/`hr`/`bs`/`sh` under any spelling.
  `POLLY_UNSUPPORTED_LANGS` is correct and no Polly setting closes the gap.
- **Every pinned voice exists and supports its pinned engine.** The
  docs-derived table was right; nothing needed repair.
- **Russian is the quality floor and is unfixable inside Polly** —
  `Tatyana` **and** `Maxim` are both `standard`-only. There is no neural
  Russian voice at all, so this is a product limitation, not a config gap.
- **Six of nine languages can upgrade engine without changing voice.**
  `en`/Joanna, `de`/Vicki, `fr`/Lea, `es`/Lucia, `pt`/Camila, `pl`/Ola all
  support **`generative`** on the *same* voice id and are pinned to
  `neural`. Same speaker, better engine. `ar` (Hala) and `zh` (Zhiyu) are
  neural-only and stay put.
- Generative was verified to support **mp3, PCM 16k, PCM 8k and SSML
  `<prosody rate>`**, and the rate genuinely *applies* (70% → 6.40s,
  150% → 3.41s vs 4.82s plain) rather than being accepted and ignored.

**⚠️ Order matters if you flip the engine.** Generative costs roughly 1.9x
neural per character. Guided-topic lesson audio had **no cache** until
BOOTSTRAP-POLLY-NARRATION-CACHE, so the multiplier would have applied to
every single My Journey tap rather than once per rendered asset. Cache
first (`NARRATION_AUDIO_CACHE`, §2c-cache below), then flip. The narration
cache key includes the engine, so flipping invalidates cleanly instead of
serving stale neural audio under a generative configuration.

### 2c-cache. Guided-topic narration audio cache (BOOTSTRAP-POLLY-NARRATION-CACHE)

`synthesizeGuidedTopicNarrationAudio()` runs on every guided-topic session
start and had no cache, so each My Journey tap re-synthesized the full
~1,800-char lesson. The audio is deterministic and there are ~2,000 assets
(254 topics x 8 languages), so this was a per-tap bill and a per-tap
latency cost on the exact path the VTID-03650→03685 chain was about.

`NARRATION_AUDIO_CACHE=off|memory|s3` (default **`memory`**; an
unrecognised value resolves to `memory`, never `off` — a typo must not
silently restore per-tap billing). `s3` additionally needs
`NARRATION_AUDIO_BUCKET`; without it the code logs an error and falls back
to `memory` rather than to nothing. Provision with
`scripts/aws/setup-narration-audio-cache.sh` (bucket + lifecycle + scoped
`s3:GetObject`/`PutObject` on `vitana-ecs-task-role`).

**⚠️ The S3 leg has never executed against a real bucket** — the dependency
was newly added, the bucket does not exist yet, and the task role has no
s3 grant. Treat it as unproven until a real `cache=hit store=s3` is
observed in the gateway logs on a second tap of the same topic. Per §2b's
own lesson, configuration is not verification. The `memory` leg is tested
and works today; it just does not survive a deploy or a scale-out.

Failure posture is deliberately **unlike** the `DB_I18N_TARGET` Aurora seam,
which throws rather than falling back: a cache holds no truth and a miss has
a correct cheap recovery (synthesize), so store errors log loudly and
degrade to synthesis. A partial render is never written — every chunk-failure
path bails before the write, so a transient Polly blip cannot be frozen into
a permanently truncated lesson.

**⚠️ Live gap: this seam is gateway-only.** `vitana-v1`'s
`useTextToSpeech.ts`/`VoiceSettingsPanel.tsx` call `google-gemini-tts`/
`google-cloud-tts` Supabase edge functions **directly**, bypassing all of
the above. With GCP off, any user with a stored Google `tts_voice`
preference (persisted per-user, ten hardcoded Chirp3-HD IDs) gets silence
or an error today. Needs a Polly-backed edge function + preference
migration in `exafyltd/vitana-v1` — not done, flagged so it isn't lost.

### 2c-fish. Fish Audio — language-coverage TTS fallback (VTID-03970)

Polly's Serbian gap above (`sr`, "currently silent/broken in production")
now has a fallback: `services/gateway/src/services/tts/fish.ts`, invoked
from inside `tryPollySynthesis()`'s failure branch (`tts-provider.ts`) —
**only** when the language is one Polly has no voice for at all, never on
a transient Polly API error. Fish is a multilingual zero-shot TTS
provider (`docs.fish.audio`) — it is not a third value for `TTS_PROVIDER`,
it is strictly a fallback layered under the existing `polly`/`google`
switch, so every one of `tryPollySynthesis`'s existing call sites (ORB
`/tts` route, greeting bridge, reminder pre-render) benefits without
being individually touched.

**Opt-in, same shape as every other provider here — deploying this code
changes nothing.** Gated on BOTH `TTS_FISH_FALLBACK_ENABLED=true` AND
`FISH_API_KEY` being set (mirrors `BEDROCK_ROLE_ARN`'s "unconfigured →
`not_configured` → skipped" contract, IF-THEN 31 — `isFishConfigured()`
checks both, and the cascade eligibility gate below uses that combined
check, not the flag alone, so a half-configured Fish never gets reported
as available and then fails at the actual synthesis call).

**Voice table is curated, not a live catalog lookup — and this mattered
immediately.** Fish hosts community-uploaded voice clones with zero
content moderation on sample text. The Serbian `reference_id` initially
proposed for this integration (`f8c26ecae994449faf73bcfae844076b`,
"Srpski Razgovorni Glas") turned out to carry an explicit sexual
description and `sexy`/`intimate`/`breathy` tags in its own Fish Audio
metadata — unusable for a health/wellness assistant. Rejected; not used
anywhere. In its place: `sr` → `2ad62aaf885e4a14add09fe4a38ffd23`
("Milica - Female Serbian"), published by Fish Audio's own official
account (`author.nickname === 'Fish Official'`), described by Fish itself
as "A natural, professional Serbian voice ... suited to voice assistants,
customer support and everyday narration" — verified via `GET
/model/{id}` 2026-09-16. `FISH_VOICES` in `fish.ts` is a short, manually
reviewed table like `POLLY_VOICES` for exactly this reason — never a
request-time search of Fish's public catalog.

**Closes the cascade's one remaining gap too, same opt-in.**
`orb/live/upstream/cascaded-config.ts`'s `evaluateCascadeEligibility()`
already knew `sr-RS` is a real Amazon Transcribe streaming language
code — Serbian's ONLY blocker for the full Transcribe→Bedrock→TTS cascade
was the missing Polly voice, never STT. With Fish configured, `sr` now
resolves `ttsProvider:'fish'` and becomes cascade-eligible;
`cascaded-live-client.ts`'s synthesis leg falls back to `synthesizeFish()`
whenever `resolvePollyVoice(lang)` is null. With Fish unconfigured
(the default), behaviour is byte-for-byte unchanged — `sr` still reports
`no_polly_voice` exactly as before this VTID.

**✅ Live synthesis verified (VTID-03983).** The HTTP 402s during
VTID-03970's build were never a credit problem — `getFishModel()`
defaulted to the paid `s2.1-pro` model, and Fish's S2.1 Pro also has a
free tier, `s2.1-pro-free` (no character cap, no SLA/latency guarantee,
requests may be retained for model improvement — acceptable for a
rarely-hit language-gap fallback, not high-volume traffic). The SAME
unfunded key synthesized real audio against `s2.1-pro-free` on the first
try: HTTP 200, a valid 29,256-byte MP3 (128kbps/44.1kHz) for Serbian text
"Zdravo, ovo je test." A parallel `pcm` request's byte count implies a
duration (1.81s at 16kHz) matching the mp3's own duration (1.83s) almost
exactly — Fish honors the requested sample rate, confirming
`FISH_PCM_SAMPLE_RATE_HZ = 16_000` was correct all along. `getFishModel()`
now defaults to `s2.1-pro-free`; `scripts/tts/verify-fish-voice.ts` runs
the same live checks repeatably (also fixed a real pre-existing TS
strictness bug in the script itself — `meta` was untyped `unknown`,
never caught because the script could never run past the 402 before).
One metadata curiosity found while re-checking the voice, not a blocker:
the model's own `languages` field reports `["hr"]` (Croatian), not `sr`,
despite the title/tags/description all being explicitly Serbian — Fish's
language classification is coarser than its own marketing copy; the real
synthesis call above produced correct Serbian-sounding output regardless.

**Still not provisioned in AWS:** `FISH_API_KEY` does not exist in AWS
Secrets Manager and is not wired into any ECS task definition —
`scripts/aws/setup-fish-audio-secret.sh` provisions the secret (no
Claude Code session has `secretsmanager:CreateSecret`, same constraint
as every other provider secret here), but adding it to
`AWS-STAGE-DEPLOY-GATEWAY.yml`'s task-def wiring was deliberately left
undone in the same PR — that workflow's secret-resolution loop hard-fails
(`exit 1`) the ENTIRE staging deploy if a listed secret is not found in
Secrets Manager yet, and this session had no way to confirm the secret
exists before merging. Provision the secret first, confirm it, then wire
the task def — never the other way round (the same ordering discipline
IF-THEN 31 already requires for Bedrock).

### 2c-fish-scope. Nova Sonic / Polly / Fish — what's actually isolated, what isn't (VTID-03987)

Raised explicitly by the platform owner after a cascade latency fix
(VTID-03986) touched a file Polly-backed languages also depend on: "there
must be a separation to avoid misbehaving" between Nova2Sonic (voice-to-
voice) and TTS providers (Polly, Fish). Two different things are true here
and both matter — don't conflate them.

**Structurally guaranteed, no discipline required:** `NovaSonicLiveClient`
and `CascadedLiveClient` are different classes, chosen once per session by
`upstream-client-factory.ts`'s `createUpstreamClient()` switch. A session
gets exactly one. Nothing in `cascaded-live-client.ts` or anything under
`orb/live/upstream/cascaded/` is *reachable* from a Nova Sonic session —
not by convention, by construction. Barge-in specifically lives entirely in
`nova-sonic-live-client.ts` (fires `interruptedHandler` off Nova's own
`contentEnd.stopReason:"INTERRUPTED"`) and `full-duplex-gate.ts` — the
cascade never calls its own `interruptedHandler` at all (grep it — the
cascade's own file header has said "no barge-in mid-generation" since
VTID-03683, unrelated to any Fish work). Nothing Fish/cascade-scoped can
touch Nova's interrupt handling without deliberately opening those two
files.

**NOT isolated, and this is the real boundary to respect:** Polly and Fish
are two interchangeable TTS *backends* plugged into the SAME
`CascadedLiveClient` — that one class also owns Transcribe (STT) and the
turn/silence-gating state machine. `ru`/`pl`/`tr`/`zh`/`ar` are
cascade-eligible via Polly (live in production today); `sr` is
cascade-eligible only via Fish (opt-in). A change to `sendAudioChunk()`,
`runTurn()`'s turn logic, or anything in `cascaded-live-client.ts` outside
the TTS-selection call runs identically for every cascade language,
Polly-backed ones included — it is never possible to scope such a change
to "Fish only" without duplicating the STT/turn-gating pipeline, which this
codebase has been burned by duplicating before (VTID-03644's five diverged
language-name copies, VTID-03696's desynced workflow `paths:` list). Don't
duplicate the pipeline to manufacture isolation that would only drift.

TTS backend SELECTION is formalized instead:
`orb/live/upstream/cascaded/tts-backend.ts` exports `pollyBackend`/
`fishBackend` (each a `synthesize(text, lang)` call, swap-safe
independently) and `synthesizeCascadeReply()` (the Polly-first/Fish-fallback
selection order, single source of truth). **Rule:** a change inside
`pollyBackend`/`fishBackend` — which model/voice/engine a backend uses — is
backend-local, safe to touch for Fish-only work without touching Polly. A
change to `synthesizeCascadeReply()`'s selection order, or to anything in
`cascaded-live-client.ts` outside that one file, affects every cascade
language and needs a regression test against a Polly-backed language (e.g.
`ru`), not just `sr`/Fish — `test/orb/live/upstream/cascaded/tts-backend.test.ts`
and `cascaded-live-client-audio-gating.test.ts` both do this already; keep
the pattern.

---

## 2d. IMAGE GENERATION — AMAZON TITAN (VTID-03497)

Vertex Imagen generated images and no Anthropic model does, so this is a
separate Bedrock adapter (`services/gateway/src/providers/titan-image.ts`),
not an llm-router provider. Two consumers: `cover-image-outpaint.ts`
(outpainting) and `intent-cover-service.ts` (text-to-image) — both must be
covered, not just one.

Selected by `IMAGE_PROVIDER=vertex|bedrock`. **⚠️ Code's internal fallback
when unset is still `vertex` — now permanently unreachable.** Production/
staging must set `IMAGE_PROVIDER=bedrock` explicitly (verify on live ECS
task defs); also gated on `BEDROCK_ROLE_ARN` (§2b).

**Three Titan constraints that produce a plausible-but-wrong image if missed:**
1. **Only fixed width/height pairs — 1600x900 isn't one.**
   `nearestTitanSize()` maps to 1280x720 (largest 16:9), outpaint upscales
   back. Weights aspect ratio over area on purpose — satisfying 16:9 with a
   square crop would visibly letterbox the subject.
2. **Outpaint mask polarity is INVERTED vs Imagen, and unverified against a
   real call.** Imagen: white=generate. Titan: documented the other way, so
   the code negates the mask before sending. Backwards = the **subject**
   gets regenerated instead of the margins — a plausible-looking wrong
   image. Override via `TITAN_OUTPAINT_MASK_POLARITY=black-generates|
   white-generates` (default `black-generates`) — **flip this first** if
   output looks wrong. Mask resize uses `kernel:'nearest'` to stay two-tone.
3. **Not offered in every region** — `AWS_TITAN_IMAGE_REGION` is its own
   var (→ `AWS_BEDROCK_REGION` → `AWS_REGION` → `us-east-1`), doesn't
   inherit blindly. Wrong region = opaque model-not-found.

Also: Titan reports content-policy blocks in an `error` field on a **200**
response (doesn't throw) — mapped to `error:'blocked'`. There is **no**
server-side letterbox-blur fallback (that's frontend-only); a Titan
failure surfaces as an error, not a degraded image.

**Before flipping `IMAGE_PROVIDER=bedrock`:** run
`scripts/images/verify-titan-image.ts` — checks model availability, the
16:9 size mapping, and renders a deterministic red-subject probe that
detects inverted mask polarity automatically. Needs `bedrock:InvokeModel`
on the gateway task role.

---

## 2e. ORB VOICE — NOVA SONIC (VTID-03501)

**Voice runs on Amazon Nova Sonic (+ the Transcribe/Bedrock/Polly-or-Fish
cascade for languages Nova can't speak) for every language except one —
Serbian goes through a narrow, explicit Vertex Live bridge on a NEW GCP
project instead, see §2e-vertex-serbian-bridge (VTID-04000).** GCP's
2026-08-16 shutdown killed the GENERAL Vertex Live fallback outright — that
part is unchanged and still true for every other language. `VERTEX_LIVE_
UNAVAILABLE=true` (`orb-live.ts`) forces Nova through its own
runtime/language gates instead of degrading to Vertex, and gates the
premature-close reconnect (below) onto the honest `connection_issue` signal
instead of a doomed round trip to a dead endpoint — note this flag is
declared on `upstream-provider-selector.ts`'s context type but is no longer
actually READ there (VTID-03723 made the force-through unconditional); it
is NOT the mechanism the Serbian bridge uses either (see
§2e-vertex-serbian-bridge for `VERTEX_SERBIAN_BRIDGE_ENABLED`, a separate,
narrower flag). **This is zero-behavior-change until the flag is actually set on
the live task definition — verify directly, don't assume it from this file.**

Global activation: `NOVA_SONIC_GLOBAL_ENABLED='true'` (exact string) widens
**who** gets Nova past the canary allowlist — `enabled`/language
(`en/de/fr/es`)/`aws-ecs` runtime gates still apply. Promoted sessions
report `reason:'nova_global_enabled'`, `canary:false`; reversible via one
`AWS-PROD-DEPLOY-GATEWAY.yml` dispatch (`nova_sonic_global_enabled=false`).

**Known failure mode, still unroot-caused:** Nova drops ~10% of sessions
with `code: nova_stream_error, diagnostic: "Premature close"` — the
bidirectional HTTP/2 stream dies at open (`audio_in=0`, `audio_out=0`,
`greeting_sent=true`) and **the user hears silence with no visible error**.
`audio_out===0` is a perfect discriminator for this reason vs. any other
close. The HTTP/1.1 workaround used for Bedrock (§2b) doesn't apply here —
`InvokeModelWithBidirectionalStream` requires HTTP/2.

With `VERTEX_LIVE_UNAVAILABLE` set, a premature-close now reports the
honest `connection_issue` signal rather than attempting a reconnect to
dead Vertex — this is a harder open problem than before the GCP shutdown,
since the old mitigation (silently reconnect to Vertex) is gone. A real
fix needs either a Nova-side retry or another AWS-native recovery path.

### 2e-duplex. Full-duplex voice / barge-in (VTID-03706) — STAGING ONLY

**`ORB_FULL_DUPLEX_ENABLED=true`.** Anything else — unset, `false`, a
typo, a leftover `staging-only` — resolves to OFF, giving the
pre-VTID-03706 half-duplex behavior, byte-for-byte. Rollback is flipping
this value, not reverting code. **Deliberately NOT set on
`AWS-PROD-DEPLOY-GATEWAY.yml`** — it changes live audio behavior for every
voice session and needs real-device echo evidence first (below).

**The rule this replaces:** the mic used to be gated SHUT while the model
spoke, in the client AND the server. So Nova received literal silence
during its own turn and its native barge-in
(`contentEnd.stopReason:"INTERRUPTED"`) could never fire — `sendEndOfTurn()`
is a documented no-op for Nova, so that event is the *only* thing that
actually stops generation. Anything quieter than 0.06 RMS could never
interrupt at all, and confirmation took ~384 ms on top.

**The rule now:** the mic never closes. During playback a frame is emitted
for *every* capture callback — verbatim above the echo floor, **digital
silence** below it. That is what makes it safe: Nova gets a continuous,
correctly-timed stream (so its turn detection works) while AEC residue is
zeroed instead of forwarded (so it cannot interrupt itself).

- Source of truth for tuning: `DUPLEX_GATE` in
  `src/orb/live/duplex/full-duplex-gate.ts`. `orb-widget.js` and
  `orb-voice-bench.js` mirror the literals; `full-duplex-gate.widget-parity.test.ts`
  fails the build if any copy drifts.
- **Nova's `INTERRUPTED` is the authority** on whether the turn yielded.
  The client's own detection only stops local playback fast (~128 ms) so
  the interruption *feels* instant. Don't "fix" a barge-in bug by making
  the client authoritative.
- Confirmation counts **voiced** frames, not merely gate-open ones —
  otherwise the hangover ticks a single cough up to the threshold in
  silence. A test pins this; it was a real bug caught before shipping.

### 2e-bench. ORB Voice Bench — `/command-hub/orb-voice-bench.html`

**The standing tool for anything you have to HEAR.** Two tabs, both needing
a real browser, speaker and (for tab 2) microphone.

**Use it — do not build a second one.** Everything else that exists is
silent by construction and none of it would catch a bad voice:
`/api/v1/voice-lab/nova/tests/run` checks Nova config, the selector table,
codecs and stream latency; `/tests/eval` checks which tools the model would
call; `runVoiceProbe()` GETs `/api/v1/orb/health` and asserts booleans — its
own comment records that the audio-path probe was never built.

**Tab 1 — TTS output.** Calls the real `POST /api/v1/orb/tts` for every
locale, decodes the result with `decodeAudioData`, plays it, and measures
it. Catches the three failures a status code cannot:
- **200 OK and silent** — peak amplitude below `TTS_SILENCE_PEAK`.
- **Wrong language** — the route echoes the `lang` it actually served;
  fluent audio in the wrong language sounds like a working system.
- **Undecodable** — an error body wearing an audio mime.

`sr` is listed with an EXPECTED-FAIL reason (Polly has no Serbian voice in
any engine), so the known gap neither hides nor reddens the sweep — and if
it ever starts passing, the verdict says so and tells you to update
`TTS_EXPECTED_FAIL`. Base URL blank = same origin; point it at
`preview-aws-gateway.vitanaland.com` to bench staging.

**Tab 2 — voice-to-voice.** The echo/barge-in gate, below.

**⚠️ The one thing that cannot be verified in CI: does this device's echo
open the gate?** There is no acoustic path in a unit test and Playwright
renders pixels, not sound. Open tab 2 on a real device, speakerphone,
headphones off, at realistic volume. It runs the identical gate against the
real mic/speaker, and starts no ORB session. Echo test must report **zero**
gate openings. If it reports any, full duplex is unsafe on that device
class — do not enable it there, and do not "fix" it by lowering
thresholds.

### 2e-vertex-serbian-bridge. Serbian voice — Vertex Live, on a NEW GCP project (VTID-04000)

**One narrow, explicit, time-boxed exception to "Vertex is not a
destination" (VTID-03723).** Serbian has no Nova Sonic voice and no Polly
voice; the Transcribe->Bedrock->Fish cascade built to cover it
(VTID-03970/03987) was measured live and does NOT fix the underlying
problem — VTID-03998 found that tuning Fish's `latency` request field makes
no measurable difference at realistic reply length (6 trials, ~535 chars:
`'normal'` avg ~9.6s, `'low'` avg ~9.6s; Fish's real throughput is ~50-60
chars/sec regardless of mode). Combined with the cascade's own
LLM-completion latency, that is what was blowing past the 30s
`greeting_timeout` stall watchdog for pre-login `sr` sessions. The platform
owner opened a **brand-new, dedicated GCP project** (never
`lovable-vitana-vers1`, which stays permanently decommissioned) with a
90-day free-credit window and asked to revive Vertex Live for Serbian only
— Gemini Live natively speaks Serbian in one hop (confirmed: `sr` is in
Google's own supported-language list for the Live API), so none of the
cascade's three-hop turn-shaping cost applies.

**The infrastructure was never deleted — only made unreachable.**
`VertexLiveClient` (full protocol handling, OAuth token caching/refresh,
prewarming) and the AWS-compatible ADC bootstrap
(`services/gateway/src/lib/gcp-adc-bootstrap.ts` — takes
`GCP_SERVICE_ACCOUNT_JSON` from Secrets Manager, writes it to disk, points
`GOOGLE_APPLICATION_CREDENTIALS` at it so `GoogleAuth`/ADC resolves on ECS,
which has no GCP metadata server) are the same code that ran in production
before the shutdown. Serbian's Gemini TTS voice mapping
(`voice-mapping.ts`'s `GEMINI_TTS_VOICE_FALLBACKS.sr`/
`NEURAL2_TTS_VOICE_FALLBACKS.sr`) was already correctly configured and
needed no change. What WAS rewired: `upstream-provider-selector.ts`
(VTID-03723) hardened every branch so no session could EVER resolve to
`provider: 'vertex'` again, after a real incident (staging's
`voice.active_provider` row silently routing pl/pt sessions to a dead
Vertex, which spoke fluent English because nothing else ever got consulted)
— `ctx.vertexUnavailable` is declared on the context type but is **no
longer read anywhere**; the force-through is unconditional now, not
flag-gated.

**The carve-out, `orb/live/upstream/vertex-serbian-bridge.ts` +
`upstream-provider-selector.ts`'s `tryVertexBridgeRescue()`:** a new,
narrow rescue helper — same "returns null when it does not apply" contract
as its sibling `tryCascadeRescue()`, checked BEFORE it at all 5 call sites
(`resolveWithoutVertex`, both branches of `evaluateNovaRequest`, both
branches of `evaluateNovaCanary`) — fires ONLY when BOTH are explicitly
true:
- `isVertexSerbianBridgeEnabled()` — `VERTEX_SERBIAN_BRIDGE_ENABLED` exact
  string `'true'` (same activation-gate convention as
  `NOVA_SONIC_GLOBAL_ENABLED`/`isCascadeEnabled()` — a typo is off).
- `isVertexSerbianBridgeLanguage(lang)` — the session language is `sr`
  (any region/script suffix), and ONLY `sr`. Never widened to a language
  list.

New `SelectionReason: 'vertex_serbian_bridge'` so telemetry/dashboards can
tell this narrow path apart from every historical vertex reason. Both
fields are precomputed by the caller (`routes/orb-live.ts`'s
`connectToLiveAPI`) exactly like `nova`/`cascade` — the selector itself
never reads env vars or inspects language strings.

**⚠️ `VERTEX_PROJECT_ID`'s own code default is still the DECOMMISSIONED
project.** `orb/live/config.ts`: `process.env.GOOGLE_CLOUD_PROJECT ||
process.env.GCP_PROJECT_ID || 'lovable-vitana-vers1'`. If the new task-def
sets `VERTEX_SERBIAN_BRIDGE_ENABLED=true` without ALSO setting
`GOOGLE_CLOUD_PROJECT` (or `GCP_PROJECT_ID`) to the new project, the bridge
will pass its own config-presence check (the string is never empty) and
then fail for real against a project with no billing account. Always
verify both are set together — this is the same ordering discipline
CLAUDE.md's Bedrock IF-THEN 31 already requires ("configure and verify
FIRST, then flip the routing flag — never the other way round"), here for
`GOOGLE_CLOUD_PROJECT`/`VERTEX_SERBIAN_BRIDGE_ENABLED` instead.

**Provisioning — pivoted from an AWS-Secrets-Manager service-account key to
Workload Identity Federation (WIF), because the key design was blocked at
the GCP org level.** `scripts/aws/setup-vertex-serbian-bridge.sh` (dry-run
by default, `--apply` to create; refuses outright if `--gcp-project
lovable-vitana-vers1` is passed) still exists and still creates a scoped
service account + downloadable key for AWS Secrets Manager — but that path
was never actually usable on the platform owner's own GCP org, because the
org-wide policy `iam.disableServiceAccountKeyCreation` blocks EVERY
service-account private-key download, confirmed live in the Console by the
org Owner repeatedly. That is an org-level block on the action itself, not
a permissions gap any identity can be granted around.

**What's actually wired on staging is WIF instead** — Google's own
recommended keyless alternative. The platform owner provisioned it
themselves via Google Cloud Shell (`gcloud iam workload-identity-pools
create vitana-aws-pool`, `... providers create-aws vitana-aws-provider
--account-id=472838866351`, `gcloud iam service-accounts
add-iam-policy-binding vitanaland@project-da3eb05a-c86e-47cb-85f
.iam.gserviceaccount.com --role=roles/iam.workloadIdentityUser
--member="principal://iam.googleapis.com/projects/20926255361/locations/
global/workloadIdentityPools/vitana-aws-pool/subject/<aws-principal-arn>"`)
— this trusts one specific AWS principal directly and lets it exchange its
own native AWS credentials for a GCP token via Google's STS endpoint, with
no downloadable key ever created. `gcloud iam workload-identity-pools
create-cred-config` then produces the authoritative `external_account`
credential config JSON — Google's own docs confirm this file contains no
private key (only pool/provider/STS-endpoint federation metadata), so it
is safe to store as a **plain, non-secret value**, unlike a service-account
key.

`AWS-STAGE-DEPLOY-GATEWAY.yml` assigns that JSON to a static
`GCP_CRED_CONFIG` variable and wires `GOOGLE_CLOUD_PROJECT`/
`VERTEX_AI_LOCATION`/`VERTEX_SERBIAN_BRIDGE_ENABLED`/
`GCP_SERVICE_ACCOUNT_JSON` UNCONDITIONALLY (no `describe-secret`, no `if`
guard — there is no absent-vs-present secret state any more) in the same
strip/re-add block as `AURORA_CA_BUNDLE_PATH`. `gcp-adc-bootstrap.ts` and
`google-auth-library`'s `GoogleAuth()` both already handle an
`external_account` credential JSON generically — zero code changes were
needed to consume it. **Not yet independently confirmed against a live
token exchange** — verifying the config resolves a real GCP OAuth token
locally was attempted and blocked by this session's own sandbox safety
layer (flagged as a containment-escape-shaped action, due to the config's
AWS-instance-metadata `credential_source` URLs); the config is Google's
own authoritative tool output against the real, live pool/provider/
binding, not hand-constructed, but the real signal is still the next real
`sr` session on staging reporting `reason:'vertex_serbian_bridge'` in
`oasis_events` and actually producing audio. Full detail: `docs/validation/
VTID-04000/acceptance.md`.

**⚠️ Pre-existing parity gap, surfaced by this PR's own CI, not caused by
it — read before flipping the flag.** This repo's `voice-pipeline-parity`
scanner (report-only, runs on every gateway PR) flagged 13 `high`-severity
`missing_in_vertex` items on PR #3369: 7 OASIS event topics
(`orb.live.context.bootstrap`, `orb.live.context.bootstrap.skipped`,
`orb.live.tool.executed`, `orb.navigator.requested`,
`orb.navigator.blocked`, `admin.briefing.injected`,
`feedback.ticket.created`) and 6 watchdog settings
(`session_timeout_ms`, `conversation_timeout_ms`,
`max_connections_per_ip`, `max_reconnects`, `max_history_chars`,
`extraction_throttle_ms`) that the LiveKit/Nova pipeline has and
`VertexLiveClient` does not. These are not regressions this VTID
introduced — `VertexLiveClient` has been structurally unreachable since
VTID-03723 while the LiveKit/Nova side kept shipping features, so the gap
accumulated during the months Vertex sat dormant. **Concretely: a real
Serbian bridge session, once enabled, will not get the same
session/conversation timeout enforcement, connection-count capping,
reconnect capping, or OASIS observability every Nova/cascade session
gets.** `safety_critical: 0` on the scan (no crash/security-class gap),
but a session with no watchdog timeout is a real operational risk under
real Serbian traffic, not just a documentation gap. Before promoting this
bridge past a small canary, either backport the missing watchdogs into
`VertexLiveClient` or confirm gateway-level timeouts elsewhere already
bound it — do not assume parity with Nova/cascade sessions just because
the code path is the same one that ran before the 2026-08-16 shutdown.

**⚠️ No longer inert on staging, once this PR's WIF wiring merges — this
superseded the original "ships inert" design.** The original plan
(`VERTEX_SERBIAN_BRIDGE_ENABLED` gated behind an AWS-Secrets-Manager
`describe-secret` check, absent by default) really was inert until an
operator provisioned the secret. The WIF replacement above wires
`GOOGLE_CLOUD_PROJECT`/`VERTEX_AI_LOCATION`/`VERTEX_SERBIAN_BRIDGE_ENABLED`/
`GCP_SERVICE_ACCOUNT_JSON` UNCONDITIONALLY on `AWS-STAGE-DEPLOY-GATEWAY.yml`
— there is no secret to be absent any more, so the bridge activates for
real on the very next staging deploy after this merges, with no separate
operator step. `AWS-PROD-DEPLOY-GATEWAY.yml` is untouched — prod stays
inert regardless.

**⚠️ The bridge's tool catalog is byte-budgeted (VTID-04026) — do not
"restore" the full catalog for Serbian without re-measuring.** Post-login
`sr` sessions closed with `upstream_ws_close code:1007 "Request contains an
invalid argument."` on ~80% of sessions — never at setup, always ~300 ms
after the FIRST generation request — which the widget surfaces as the
endless spoken "hold on, I'm reconnecting" loop. Three greeting-wording
fixes (VTID-04010/04014/04015) did not move the rate because the greeting
was never the cause: an authenticated community session declares **290
function declarations = 226 KB** of JSON in `setup.tools` (anonymous: 2 /
4.9 KB), on top of the 30 KB instruction the `instruction-budget.ts` guard
bounds — the catalog itself had no bound, and Gemini Live rejects the
oversized aggregate on the first generation, not the handshake (the exact
shape `live-system-instruction.ts` already recorded from the pre-shutdown
era). Proven live, same account/language/deployment, only the surface
changed: community (290 tools) 2/8 turns completed, admin (134 tools /
45 KB) 8/8. `orb/live/tools/vertex-tool-catalog-budget.ts` now packs the
catalog to `VERTEX_TOOL_CATALOG_BYTE_BUDGET` (default 48 KB, inside the
measured-working point; `0` disables) with a priority list — navigation,
`end_conversation`, memory/diary/reminders, the guided-journey/teacher
tools, persona hand-off, calendar, messaging, daily logs — kept first;
applied in `orb-live.ts`'s envelope builder ONLY when
`session.upstreamProvider === 'vertex'` (never keyed on language), so Nova
Sonic and the cascade keep the full catalog. A trim is an OASIS diag
(`stage=vertex_tool_catalog_trimmed`), not a console line, because
VTID-04021's handoff could not even confirm whether the instruction guard
was firing without CloudWatch. The ~80/20 split on byte-identical requests
is consistent with `VERTEX_AI_LOCATION=global` routing to backends with
different effective limits — a hypothesis, not established; shrinking the
request fixes the failure whichever backend serves it. Raising the budget
is an env change once a larger value is observed to hold on staging.

**90-day window.** This is a bridge, not a standing architecture decision
— when the credit window ends (or the cascade's own turn-shaping latency
gets fixed some other way), the fix is one flag flip
(`VERTEX_SERBIAN_BRIDGE_ENABLED=false`) plus deleting the GCP project and
its WIF pool/provider/binding; the selector code can stay (inert, harmless)
or be removed in a follow-up cleanup VTID.

---

## 3. DATABASE (SUPABASE — Aurora migration is IN PROGRESS, not complete)

> **Status check against this repo, 2026-08-18 — do not assume Aurora is
> primary anywhere yet.** `SUPABASE_URL`/PostgREST is still the connection
> used by ~231 files under `services/gateway/src`; `AURORA_DATABASE_URL` is
> referenced by 2. `DB_I18N_TARGET` (the one seam with a real Aurora write
> path — VTID-03515/03517) still defaults to `supabase`, and its own header
> comment says explicitly: *"Not a migration, and not Aurora becoming
> primary."* A DMS reconciliation script
> (`scripts/reconciliation/aurora-supabase-reconcile.ts`) exists but per its
> own VTID-03649 commit note had **not yet been exercised against real
> credentials** as of 2026-08-16. Treat "we've moved to Aurora" as the
> **target direction**, not the current state, until each of these is
> re-verified — most consumers reading this file should keep writing
> Supabase-client code exactly as before; only touch the Aurora seam if you
> are specifically working the DB migration itself.

### Critical Rules
1. **PostgreSQL tables MUST use `snake_case`** (vtid_ledger, oasis_events)
2. **TypeScript code MUST reference EXACT table names**
3. **Check DATABASE_SCHEMA.md before creating any table**

### Core Tables
| Table | Purpose |
|-------|---------|
| `vtid_ledger` | Central VTID task tracking |
| `oasis_events` | System-wide event log |
| `personalization_audit` | Cross-domain personalization audit — **⚠️ confirmed still missing in live Supabase** (`to_regclass` null, re-checked 2026-08-29). **Investigated 2026-08-29: reachable but NOT a silent-failure bug.** The one real call site (`writePersonalizationAudit()` in `personalization-service.ts`, invoked fire-and-forget from `GET /api/v1/personalization/snapshot`) already checks `response.ok` and logs loudly via `console.error` on failure, and the route never awaits it (`.catch(err => console.warn(...))`) — so every snapshot request logs a write failure but the user-facing response is unaffected. The two `app.js`/`app.js.backup*` hits are static Command Hub schema-catalog metadata, not live queries. Net: a known, correctly-degrading gap in the audit trail, not a confidently-wrong response — building the table (or retiring the audit feature) is a product decision, not a bug fix. |
| `services_catalog` | Service catalog |
| `products_catalog` | Product catalog |
| `d44_predictive_signals` | Proactive intervention signals — **⚠️ does not exist in live Supabase**, confirmed reachable from a live admin screen (Intelligence → Signals) that surfaces this as a visible error. See `docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md` Addendum 2. |
| `contextual_opportunities` | D48 opportunity surfacing |
| `risk_mitigations` | D49 risk mitigation — **⚠️ does not exist in live Supabase**, route is mounted but no confirmed caller found — same "registered but never invoked" shape confirmed for the `AP-0710` monetization-vulnerability automation. See `docs/AURORA-B2-DEAD-CALLSITE-AUDIT.md` Addendum 3 and Addendum 10. |

### vtid_ledger Key Columns
| Column | Type | Values |
|--------|------|--------|
| `vtid` | TEXT | Primary key (VTID-XXXXX format) |
| `status` | TEXT | scheduled, in_progress, completed, pending, blocked, cancelled |
| `spec_status` | TEXT | draft, pending_approval, approved, rejected |
| `is_terminal` | BOOLEAN | Task completion flag |
| `terminal_outcome` | TEXT | success, failed, cancelled |
| `claimed_by` | TEXT | Worker ID that claimed the task |
| `claimed_until` | TIMESTAMPTZ | Claim expiration |

### DEPRECATED - DO NOT USE
- `VtidLedger` (PascalCase) - Empty, use `vtid_ledger`

---

## 6. OASIS EVENTS

### Event Taxonomy
| Category | Examples | When to Emit |
|----------|----------|--------------|
| `vtid.lifecycle.*` | started, completed, failed | State changes |
| `vtid.stage.*` | planner.started, worker.success | Stage transitions |
| `vtid.decision.*` | claimed, released, retried | Decisions |
| `vtid.error.*` | failed, blocked | Errors |
| `telemetry.*` | heartbeat, polled | **NEVER to OASIS** |

### Critical Rule
> **OASIS is for STATE TRANSITIONS and DECISIONS — not loops.**
> Polling ≠ progress. Heartbeat ≠ event. Repetition ≠ signal.

### Event Schema
```typescript
{
  id: UUID,
  type: string,          // Event type (e.g., vtid.lifecycle.completed)
  topic: string,         // Event topic/category
  source: string,        // Service name
  vtid: string,          // Associated VTID
  service: string,
  status: string,        // info, success, warning, error
  message: string,
  payload: JSONB,
  created_at: TIMESTAMPTZ
}
```

---

## 7. WORKER ORCHESTRATOR API

### Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/worker/orchestrator/register` | Register worker |
| DELETE | `/api/v1/worker/orchestrator/register/:id` | Deregister worker |
| GET | `/api/v1/worker/orchestrator/workers` | List workers |
| GET | `/api/v1/worker/orchestrator/tasks/pending` | Get pending tasks |
| POST | `/api/v1/worker/orchestrator/claim` | Claim a task |
| POST | `/api/v1/worker/orchestrator/release` | Release a claim |
| POST | `/api/v1/worker/orchestrator/route` | Route to subagent |
| POST | `/api/v1/worker/orchestrator/heartbeat` | Send heartbeat |
| POST | `/api/v1/worker/subagent/start` | Report subagent start |
| POST | `/api/v1/worker/subagent/complete` | Report subagent complete |
| POST | `/api/v1/worker/orchestrator/complete` | Report orchestrator complete |
| POST | `/api/v1/worker/orchestrator/terminalize` | Terminalize VTID |

---

## 10. CODING CONVENTIONS

### TypeScript
- Use strict types
- Use Zod for validation
- Use Express Router pattern

### API Patterns
- All API routes under `/api/v1/`
- Use snake_case for JSON response fields
- Return `{ ok: boolean, error?: string, data?: T }`

### File Organization
```
services/<service>/
  src/
    index.ts           # Entry point
    types.ts           # TypeScript types
    routes/            # API routes
    services/          # Business logic
  Dockerfile
  package.json
  tsconfig.json
```

---

## 13. VTID REFERENCES IN THIS CODEBASE

Key VTIDs that established patterns:
- **VTID-0416** - Gateway Deploy Governance Lockdown
- **VTID-0542** - VTID Allocator Hard Gate
- **VTID-01010** - Target Role System
- **VTID-01032** - Multi-service Auto-deploy
- **VTID-01181** - DB-backed Allocator Toggle
- **VTID-01187** - Execution Governance Defense in Depth
- **VTID-01200** - Worker-Runner Execution Plane

---

## 13b. SERVER-SIDE i18n (PR #2269)

The gateway emits some strings directly to users (push notifications, email
subjects, voice greetings, error bodies) where the frontend can't intercept
and translate. The German community has been complaining about English text
showing on their lock screen — this is the surface that causes it.

### Hard rule

**Never** hardcode a user-visible string in a gateway response. Use the
catalog:

```ts
import { tt, type GatewayI18nKey } from '../i18n/catalog';
import { getUserLocale, bulkGetUserLocales } from '../i18n/server-locale';

// Single user
const lc = await getUserLocale(supa, user_id);
title: tt('notif.diary_reminder.title', lc),
body:  tt('notif.diary_reminder.body', lc, { count: 3 }),

// Cron fan-out (many users)
const locales = await bulkGetUserLocales(supa, userIds);
for (const u of users) {
  const lc = locales.get(u.user_id);
  await notify(u.user_id, tt('notif.x.title', lc), tt('notif.x.body', lc));
}
```

### Adding a new key

1. Add the key to `GatewayI18nKey` union in `services/gateway/src/i18n/catalog.ts`.
2. Add translations to **all four** locale objects (DE, EN, ES, SR). DE
   must be a real translation; ES/SR can start as a copy of EN and graduate
   through the audit workflow later.
3. Use `tt(key, locale, params?)` in the route handler.

### Locale resolution priority

1. `app_users.locale` (canonical)
2. `memory_facts.fact_key='preferred_language'` (fallback)
3. `'de'` (default)

5-min in-process cache. Cron jobs that fan out over thousands of users
must use `bulkGetUserLocales` to batch-fetch in one query.

### What does NOT need translation

- **System instructions sent to the LLM** (`buildLiveSystemInstruction`,
  agent personas, tool prompts) — the LLM reads English instructions and
  emits German output when told `Respond ONLY in {language}`. Translating
  system prompts hurts model performance.
- **Internal state identifiers** (currency codes, tab IDs, status enums) —
  these are not user-visible.
- **Debug/telemetry logs** — never translated.

---

## 13c. VITANALAND COMMERCE — LONG-TERM VISION (self-service merchant onboarding)

**Standing product-direction framework, not a technical spec** — evaluate
recurring Discover/Commerce work against this, not just the immediate ticket.

**Goal:** any business (existing or new) connects to Discover the way
DoctorBox/Awin/Amazon.ae/Admitad did, **without an engineer hand-writing a
SQL migration.** Today's path is fully manual (catalog gathering →
affiliate negotiation → engineer seeds `merchants`/`products` by hand);
target is self-service, Shopify-like (low-friction onboarding, app-store
connection flow, merchant control over their own catalog/pricing).

**Near-term rule:** when doing incremental Discover/Commerce work (new
merchant seed, sync provider, attribution mechanism, commission flow),
prefer schema/config choices a future onboarding UI could drive over ones
only an engineer running a migration could drive — and flag it explicitly
when a shortcut adds to the hand-seeded onboarding debt pile, rather than
silently repeating it.

---

## 14. MEMORY & INTELLIGENCE ARCHITECTURE (VTID-01225)

This section documents the complete Memory & Intelligence stack, including how data flows from input (ORB/Operator Console) through extraction, storage, and retrieval for personalized responses.

### Data Input Channels

| Channel | Technology | Entry Point |
|---------|------------|-------------|
| **ORB Voice** | Amazon Nova Sonic (WebSocket) — see §2e; the Gemini Live API this row named is decommissioned | `orb-live.ts` |
| **Operator Console** | REST API (Text/Tasks) | `conversation.ts` |

### Memory Garden Categories (13 Total)

| Category Key | Display Name | Source Mappings |
|--------------|--------------|-----------------|
| `personal_identity` | Personal Identity | personal_identity |
| `health_wellness` | Health & Wellness | health |
| `lifestyle_routines` | Lifestyle & Routines | preferences |
| `network_relationships` | Network & Relationships | relationships, community, events_meetups |
| `learning_knowledge` | Learning & Knowledge | learning, education, skills |
| `business_projects` | Business & Projects | tasks |
| `finance_assets` | Finance & Assets | products_services |
| `location_environment` | Location & Environment | location, travel |
| `digital_footprint` | Digital Footprint | digital, online |
| `values_aspirations` | Values & Aspirations | goals |
| `autopilot_context` | Autopilot & Context | autopilot |
| `future_plans` | Future Plans | plans, milestones |
| `uncategorized` | Uncategorized | conversation, notes |

### Process Flow (Sync - User Response Path)

```
User Input (ORB/Operator)
       │
       ▼
┌──────────────────────────────────────────┐
│  1. Write raw conversation               │
│     writeMemoryItemWithIdentity()        │
│     → memory_items (category: conv)      │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  2. Retrieval Router (D2)                │
│     retrieval-router.ts                  │
│                                          │
│     Rules (priority order):              │
│     • vitana_system (100) → Knowledge    │
│     • personal_history (90) → Memory     │
│     • health_personal (85) → Memory      │
│     • external_current (80) → Web        │
│     • general_knowledge (50) → Knowledge │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  3. Context Pack Builder                 │
│     buildContextPack() /                 │
│     buildBootstrapContextPack()          │
│                                          │
│     Sources:                             │
│     • Memory Garden (fetchDevMemory)     │
│     • Knowledge Hub (searchKnowledge)    │
│     • Web Search (disabled in bootstrap) │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  4. LLM Generation (Claude via Bedrock)  │
│                                          │
│     System Instruction includes:         │
│     - User context from memory           │
│     - Personalization data               │
│     - Domain-specific knowledge          │
└──────────────────────────────────────────┘
       │
       ▼
   Response to User
```

### Process Flow (Async - Extraction & Persistence)

```
Session End / Conversation Complete
       │
       ▼
┌──────────────────────────────────────────┐
│  1. Cognee Extraction                    │
│     cogneeExtractorClient.extractAsync() │
│                                          │
│     Extracts:                            │
│     • PERSON entities                    │
│     • DATE entities                      │
│     • LOCATION entities                  │
│     • RELATIONSHIP entities              │
└──────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────┐
│  2. Persist Extraction Results           │
│     persistExtractionResults()           │
│                                          │
│     A. RELATIONSHIP GRAPH (VTID-01087)   │
│        → relationship_ensure_node() RPC  │
│        → relationship_nodes table        │
│                                          │
│     B. MEMORY FACTS (VTID-01192)         │
│        → write_fact() RPC                │
│        → memory_facts table              │
│        → Semantic keys: user_name,       │
│          user_birthday, fiancee_name     │
│        → Provenance: assistant_inferred  │
│        → Auto-supersession built-in      │
│                                          │
│     C. MEMORY ITEMS (Legacy)             │
│        → Direct INSERT                   │
│        → memory_items table              │
│        → Uses source category mapping    │
└──────────────────────────────────────────┘
```

### Database Schema (Memory & Intelligence)

```
┌─────────────────────────────────────────────────────────────────┐
│                      MEMORY GARDEN                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  memory_facts (VTID-01192)     memory_items (VTID-01104)       │
│  ┌──────────────────────┐      ┌──────────────────────┐        │
│  │ fact_key             │      │ category_key         │        │
│  │ fact_value           │      │ content              │        │
│  │ entity (self/discl)  │      │ content_json         │        │
│  │ provenance_source    │      │ importance           │        │
│  │ provenance_confidence│      │ embedding (pgvector) │        │
│  └──────────────────────┘      └──────────────────────┘        │
│                                         │                       │
│                          memory_category_mapping                │
│                          ┌──────────────────────┐               │
│                          │ source → garden      │               │
│                          │ health → health_well │               │
│                          │ tasks → business_proj│               │
│                          └──────────────────────┘               │
│                                                                 │
│  memory_garden_config (13 categories)                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ personal_identity, health_wellness, lifestyle_routines,  │   │
│  │ network_relationships, learning_knowledge, business_proj, │   │
│  │ finance_assets, location_environment, digital_footprint, │   │
│  │ values_aspirations, autopilot_context, future_plans,     │   │
│  │ uncategorized                                             │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                   RELATIONSHIP GRAPH (VTID-01087)               │
├─────────────────────────────────────────────────────────────────┤
│  relationship_nodes → relationship_edges → relationship_signals │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ node_type       │  │ from_node_id    │  │ signal_type     │  │
│  │ display_name    │  │ to_node_id      │  │ signal_value    │  │
│  │ metadata        │  │ relation_type   │  │ computed_at     │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `services/gateway/src/services/cognee-extractor-client.ts` | Cognee extraction + persistence |
| `services/gateway/src/services/retrieval-router.ts` | Routing decisions for context sources |
| `services/gateway/src/services/context-pack-builder.ts` | Builds context pack for LLM |
| `services/gateway/src/services/orb-memory-bridge.ts` | Memory read/write bridge |
| `services/gateway/src/routes/orb-live.ts` | ORB Live API session handling |
| `supabase/migrations/20260119000000_vtid_01192_infinite_memory_v2.sql` | memory_facts + write_fact() |
| `supabase/migrations/20260203000000_vtid_01225_extend_memory_category_mapping.sql` | Extended 13 categories |

### Retrieval Router Rules

| Rule Name | Priority | Triggers | Primary Source |
|-----------|----------|----------|----------------|
| `vitana_system` | 100 | "vitana", "oasis" | Knowledge Hub |
| `personal_history` | 90 | "remember", "my name", "told you" | Memory Garden |
| `health_personal` | 85 | "my health", "my sleep" | Memory Garden |
| `external_current` | 80 | "news", "weather", "stock price" | Web Search |
| `general_knowledge` | 50 | "what is", "how to" | Knowledge Hub |

### write_fact() RPC (VTID-01192)

```sql
write_fact(
  p_tenant_id UUID,
  p_user_id UUID,
  p_fact_key TEXT,           -- Semantic key: user_name, user_birthday, fiancee_name
  p_fact_value TEXT,         -- The value: "Dragan Alexander", "September 9, 1969"
  p_entity TEXT,             -- 'self' or 'disclosed'
  p_fact_value_type TEXT,    -- 'text', 'date', 'number'
  p_provenance_source TEXT,  -- 'user_stated', 'assistant_inferred'
  p_provenance_confidence FLOAT -- 0.0 to 1.0
) RETURNS UUID
```

**Features:**
- Auto-supersession: New fact with same key replaces old
- Provenance tracking: Source and confidence stored
- Entity scope: Distinguishes user facts vs facts about others

### Critical Fix (VTID-01225)

**Before:** `extractAsync()` called Cognee, logged results, then **dropped them**
**After:** `extractAsync()` calls Cognee, then **persists to 3 storage systems**:
1. `relationship_nodes` via `relationship_ensure_node()` RPC
2. `memory_facts` via `write_fact()` RPC
3. `memory_items` for legacy retrieval compatibility

---

