# VTID-03683 — Acceptance

**Nova Sonic cannot speak Russian, Polish, Serbian, Arabic or Chinese at all,
and since Vertex Live died those languages are forced onto it anyway. This adds
a three-hop pipeline — Transcribe → Bedrock → Polly — for exactly the languages
Nova cannot serve, and for nothing else.**

## The defect

`NOVA_SONIC_SUPPORTED_LANGUAGES` is `['en','de','fr','es','pt']`. Nova has no
Russian, Polish, Serbian, Arabic or Chinese speech-to-speech capability — this
is not a configuration gap, there is nothing to switch on.

Those sessions reach it regardless. `upstream-provider-selector.ts` reads:

```ts
if (languageBlocked && !vertexDead) → pin to Vertex
```

and `VERTEX_LIVE_UNAVAILABLE=true` (Vertex Live died with GCP, VTID-03649), so
the language gate is **skipped** and the session is forced onto Nova. That was a
deliberate tradeoff at the time — degraded speech beats a guaranteed connection
failure to a dead endpoint — but it left five languages with no working voice
and no remaining path to one.

Measured on production over 14 days, mean `audio_out` per `turn_complete`
(`outputs/prod-telemetry.txt`):

```
de 173.0   en 160.7      <- Nova supports these
sr  38.3   pl  35.5   ru  29.8      <- Nova does NOT
```

A 4-5× shortfall landing on exactly the unsupported languages. **This corrects a
claim made earlier in this same workstream that "pl and sr work" —** they do not;
`pl` is merely less visibly broken than `ru`. VTID-03682 already eliminated the
voice as the explanation (all five resolve to the same `tina`), which is what
left the language ceiling itself as the remaining cause.

## Why a cascade rather than fixing Nova

There is no fix to make. The cascade decomposes the one thing Nova does
atomically (speech → speech) into three steps that each *do* support these
languages:

```
user audio ──▶ Transcribe (streaming) ──▶ Bedrock ──▶ Polly ──▶ audio out
```

It is strictly worse than speech-to-speech on latency and prosody, and has no
barge-in. That is precisely why it is scoped to languages that today produce
~30 audio chunks a turn, and why a language Nova speaks must never reach it.

---

AC-1 — The gate REFUSES every language Nova speaks natively. Routing `de` here
would trade a working speech-to-speech session for a slower three-hop one — a
regression wearing a fix's clothes. Asserted by iterating
`NOVA_SONIC_SUPPORTED_LANGUAGES` and requiring the gate to answer for each,
rather than spot-checking one language; a spot check passes the moment someone
adds `ru` and says nothing about the next language added, which is exactly how
the VTID-03681 seam bug shipped.
TEST: `test/orb/live/upstream/cascaded-voice.test.ts` →
"REFUSES every language Nova speaks natively"

AC-2 — It takes exactly the languages Nova cannot speak AND both AWS services
can: `ru`, `pl`, `ar`, `zh`. `listCascadeLanguages()` is computed from the
predicate rather than hand-maintained — a list that can drift from the rule it
describes is a list that will.
TEST: `test/orb/live/upstream/cascaded-voice.test.ts` →
"takes exactly the languages Nova cannot speak AND both AWS services can"

AC-3 — `sr` is refused, and the refusal blames **Polly**, the blocker that is
actually verified. Polly has no Serbian voice in any engine (VTID-03578), read
live from `resolvePollyVoice()` in this repo. Serbian therefore still has **no
working ORB voice** after this change — the cascade narrows the outage from five
languages to one, it does not close it. An earlier draft checked Transcribe
first and reported `no_transcribe_language` for `sr`, attributing the gap to the
table this repo is least sure about and sending the next person to fix a service
that was never the problem. `sr-RS` is in fact a real Transcribe streaming
language code — confirmed against the SDK's own `LanguageCode` union — so it is
listed, which makes the stated reason demonstrably true rather than accidentally
true.
TEST: `test/orb/live/upstream/cascaded-voice.test.ts` →
"refuses sr, and blames POLLY — the blocker that is actually verified"

AC-4 — Coverage is DERIVED from `resolvePollyVoice()`, not restated as a second
hardcoded list, so a Polly coverage change cannot silently disagree with this
gate. This is the seam assertion, and it is the defect class this repo has paid
for twice: VTID-03578 (`pt`/`pl` in neither Polly table, falling through to
fluent English) and VTID-03681 (seven tables out of step).
TEST: `test/orb/live/upstream/cascaded-voice.test.ts` →
"derives coverage from Polly rather than restating it"

AC-5 — It is INERT until switched on. With `ORB_CASCADED_VOICE_ENABLED` unset,
selector behaviour is byte-for-byte the existing forced-Nova path — deploying
this changes no routing for anyone. The flag requires the exact string `'true'`,
matching `NOVA_SONIC_GLOBAL_ENABLED`'s convention, so a typo'd value is off
rather than truthy. All three seams mutation-verified: removing the nova-native
refusal fails 2 tests, removing the Polly-derived coverage guard fails 3, and
ignoring the activation gate fails 1 (`outputs/mutation.txt`).
TEST: `test/orb/live/upstream/cascaded-voice.test.ts` →
"is off unless the value is exactly \"true\"",
"without the flag, behaviour is byte-for-byte the old forced-Nova path",
"with the flag on and the language covered, it routes to the cascade",
"with the flag on but the language NOT covered (sr), it does not divert",
"does not claim a session that a LIVE Vertex would still have taken",
"never diverts a session whose language Nova DOES support"

---

## Route markers (VALIDATOR-CHECK exit 70/71/72)

The gate requires these because the diff touches a file under
`services/gateway/src/routes/`. It keys on the **file path**, not on whether a
route actually changed — and this change adds none, so the honest answers are
negative ones. They are recorded rather than fabricated:

ROUTE_MOUNT: **None — no route added, removed, or remounted.** The edits to
`routes/orb-live.ts` are two type annotations, changing a locally re-declared
`'vertex' | 'livekit' | 'nova_sonic'` union to the canonical `VoiceProviderName`
imported from `provider-name.ts`. The compiler flagged both sites when the new
member was added; without the change they would have silently excluded
`cascaded`. `git diff` shows no `router.get`/`.post`/`.use` change of any kind.

FINAL_URL: **Unchanged.** No new or altered URL. The affected code runs behind
the existing ORB live transports (`/api/v1/orb/live/ws` and the SSE session
path); their paths, methods, auth and response shapes are byte-identical before
and after this change.

CURL_PROOF: **Not applicable, and deliberately not fabricated.** There is no
endpoint whose response differs. With the flag unset — its state everywhere,
including after this deploy — the selector returns exactly what it returned
before, so a curl would confirm only that nothing changed, which is true but
proves nothing about the pipeline. Two things prove it instead: (1) the suite in
`test/orb/live/upstream/cascaded-voice.test.ts`, all three seams
mutation-verified (`outputs/mutation.txt`); and (2) after the flag is enabled,
`cascaded_language_rescue` in the selector's own telemetry plus `audio_out` per
turn for `ru`/`pl` measured against the 29.8/35.5 baseline recorded above — the
number this VTID exists to move. Exercising this against production is forbidden
outright by CLAUDE.md's standing rule, so a live curl was never an available
form of evidence.

## OASIS traceability (VALIDATOR-CHECK exit 80/81)

OASIS_IMPACT: yes

OASIS_PROOF: This change **adds one new selector reason and alters none**.
`selectUpstreamProvider()` can now return
`reason: 'cascaded_language_rescue'` with `provider: 'cascaded'`, reported
through the existing provider-selection telemetry that already carries
`nova_forced_vertex_unavailable`, `nova_global_enabled` and the rest. No existing
reason string, topic or payload shape is renamed or removed, so no dashboard or
query that works today can break.

The new reason is deliberately distinct from the forced-Nova reason it replaces
rather than reusing it: which mechanism served a session is exactly the fact
worth measuring once two of them can serve the same language, and collapsing
them would reproduce the VTID-03560 mistake where a promoted population kept
reporting under the canary's name. `canary: false` for the same reason.

**Honest limit on this proof:** the reason is verified by the test suite and by
reading the wired selector — it has **not** been observed in a live
`oasis_events` row, because the flag is off and this repo's standing rule forbids
exercising production to produce one. The first real confirmation is a
`cascaded_language_rescue` row after the flag is enabled; per the VTID-03681 and
VTID-03682 precedent, terminalization waits for that rather than being claimed at
merge.

VTID-03683 is `status=in_progress`, `spec_status=approved` (user-instructed in
conversation, per §4.1).

---

## Known limitation, stated rather than hidden: TOOLS ARE NOT WIRED

`onToolCall` never fires on this path, so the ORB tool catalog is unavailable: a
Russian user gets conversation, not actions. `sendToolResult()` returns `false`
and is unreachable in practice, since the session layer only calls it in response
to a tool call this client never emits — so it cannot hang waiting for one, which
is the failure mode Nova has when a `toolUse` goes unanswered.

This is deliberate scope, not an oversight. `callViaRouter` already supports
tools (VTID-03579 added `toolCalls`), so wiring the loop is a follow-up increment
rather than a redesign. Shipping conversation-only for languages that today
produce garbled fragments is a strict improvement; claiming tool parity it does
not have would not be.

## What this does NOT do

- **It does not give Serbian a voice.** Polly has no Serbian voice in any engine
  and no other TTS provider is wired since GCP went off. `sr` is refused by name,
  with the reason naming Polly, so it stays a visible product gap rather than
  being quietly served in the wrong language.
- **It does not enable itself.** `ORB_CASCADED_VOICE_ENABLED` is unset and this
  change does not set it, in any workflow or task definition. Enabling it is a
  separate, deliberate action — and the ordering matters for the same reason
  §2b's Bedrock rule does: the gateway task role needs
  `transcribe:StartStreamTranscription` and `polly:SynthesizeSpeech`, and
  VTID-03665 already found Polly failing silently in one environment from a
  missing permission. Verify the IAM grants first, then flip the flag.
- **It does not touch the forced-Nova path for anything else.** A language Nova
  supports, and a language the cascade cannot cover, both take exactly the route
  they take today.
- **It does not root-cause why `ru` is worse than `pl`.** Both are Nova-blocked
  and both should be rescued by this change, but `ru`'s 29.8 vs `pl`'s 35.5 —
  and `ru`'s ~172 ms turns recorded under VTID-03682 — may have a second cause
  underneath the language ceiling. If `ru` is still anomalous after the cascade
  is enabled, that is a separate investigation, not evidence this did not work.

## Dependency note (VALIDATOR-CHECK exit 20)

This change adds `@aws-sdk/client-transcribe-streaming`, which necessarily
modifies `services/gateway/package-lock.json`. The gate's `deny_common` rule
rejects any lockfile change outright, so **this PR will fail VALIDATOR-CHECK at
exit 20 and there is no way to add the required SDK without it.** The gate is
advisory rather than a required check (VTID-03681 merged with it red), and the
underlying trigger-scoping problem is already tracked as its own follow-up. It is
recorded here rather than worked around.
