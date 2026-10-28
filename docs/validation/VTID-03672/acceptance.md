# VTID-03672 — Portuguese ORB voice moves from Google to Nova

**Profile:** `gateway_backend`

`NOVA_SONIC_SUPPORTED_LANGUAGES` was the first canary list (`en/de/fr/es`) and
its own comment reads "Everything else → Vertex". So `pt`, `ru`, `pl` and `sr`
voice-to-voice have been served by **Google**, not because Nova cannot serve
them but because nobody revisited the array.

**Known gate limitation, same as VTID-03572 / VTID-03569 / VTID-03578.** This
PR carries two files outside every `VALIDATOR-CHECK` profile allowlist:
`services/gateway/scripts/verify-nova-language.mjs` (the probe that produced
the evidence below — `scripts/` is in no profile) and
`.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml`, which arrives from a
**pre-existing commit on this shared branch** (`a3fcc2f`, VTID-03580) that is
not this VTID's to drop. The path-ownership guard therefore exits 22 while the
substantive checks pass. The probe cannot simply move under
`docs/validation/`: it imports `@aws-sdk/client-bedrock-runtime`, and Node
resolves bare specifiers upward from the importing file, so outside the gateway
tree it has no module to resolve.

---

AC-1 — Portuguese voice is served by Nova, not Vertex

`pt` is a shipped GA locale whose voice traffic was reaching Google purely
through an unrevisited canary list. AWS's Nova 2 Sonic language table covers
`en/de/fr/es/pt` of our eight GA locales.

TEST: `test/orb/live/voice/nova-sonic-voice.test.ts` → "serves pt with Nova's
documented pt-BR voices". Evidence: `outputs/tests.txt`.

AC-2 — `ru`, `pl` and `sr` are NOT widened, and that is a finding not caution

The same table omits them: the model does not speak them, so widening the gate
would send those users to a model that cannot answer — the silent-fallback
shape §2e documents. `sr` additionally has no Polly voice in any engine.

TEST: `test/orb/live/voice/nova-sonic-voice.test.ts` → "still refuses the
languages Nova genuinely does not speak". Evidence: `outputs/tests.txt`.

AC-3 — the voice ids are real for THIS account, not merely documented

Documentation describes the model; entitlement is separate. VTID-03579 paid for
that distinction when `ListInferenceProfiles` reported 22 Bedrock profiles
ACTIVE and 3 were invokable. Here: the model invokes with no
`AccessDeniedException`, and `carolina`/`leo` are accepted while a deliberately
bogus id is rejected by name — which is what makes acceptance evidence rather
than the absence of an error.

TEST: `outputs/nova-language-probe.txt` (live Bedrock calls, eu-north-1).

AC-4 — the ids come from the Nova 2 table, not Nova 1

Nova 1 lists German as `greta`; this codebase and Nova 2 both use `tina`. The
v1 page would have supplied a plausible, wrong id for a model we do not run.
`pt-BR` also matches this app's Brazilian catalog (VTID-03577), so the accent
fits the text rather than reading Brazilian copy in European Portuguese.

TEST: `test/orb/live/voice/nova-sonic-voice.test.ts` → asserts `pt-BR` resolves
to `carolina`. Evidence: `outputs/tests.txt`.

AC-5 — what is NOT proven is stated, and the risk is bounded

End-to-end Portuguese generation was not exercised: Nova is speech-to-speech,
real speech input needs Polly, and this principal is denied
`polly:SynthesizeSpeech` (403). Recorded rather than glossed — and a finding in
its own right, because §2c assumes that permission on the gateway task role
before `TTS_PROVIDER=polly` can be flipped and it has never been confirmed live.

The residual risk is bounded rather than unknown: `pt` routes to Vertex today
anyway, and VTID-03502 falls a failed Nova session back to Vertex. The worst
case is current behaviour; the only new exposure is degraded rather than absent
Portuguese.

TEST: `outputs/nova-language-probe.txt` (the Polly 403 and the PARTIAL verdict).
