# VTID-03682 — Acceptance

**Nova's voice substitution was silent: Russian, Polish and Serbian have been
spoken by a German voice in production with no log, no telemetry and no signal
of any kind.**

## The defect

`routes/orb-live.ts` chose the Nova voice like this:

```ts
const novaVoice = resolveNovaSonicVoice({ language, persona }) ?? 'tina';
```

`NOVA_VOICES` has entries for `en de fr es pt` only. `SUPPORTED_LIVE_LANGUAGES`
admits **ten** languages, and since the GCP shutdown (`VERTEX_LIVE_UNAVAILABLE`,
§2e) every ORB session runs on Nova. So `ru`, `pl`, `sr`, `ar` and `zh` all
resolve to `null` and all receive **`tina`, Nova's GERMAN voice** — a real
compromise, taken silently, on every session, for months.

A bare `??` cannot be observed. The caller gets a valid-looking voice id and has
no way to distinguish "this is the right voice" from "this is a substitute".

**It is worse than unlogged — the telemetry records a voice that was never
used.** Measured on production 2026-08-19 (`outputs/prod-telemetry.txt`), 7 days:
`ru` 9 sessions / 2 users, `sr` 7 / 2, `pl` 4 / 1 — real accounts, not a
hypothetical — and `vtid.live.session.start` records their voice as `Gacrux`,
`Vindemiatrix` and `Despina` respectively. Those are **Gemini-lineage voice ids;
Nova cannot speak any of them.** Joining each session to its own provider events
confirms all three languages ran on `nova_sonic`, so every one of those sessions
was actually spoken by `tina`. Anyone asking "what voice did our Polish users
hear?" got `Despina` — a confident, specific, wrong answer, which is strictly
worse than a null: a null invites the question, a wrong value closes it.

That is the same failure family as §2b's routing table reading `anthropic` while
Google served every call — a stated intent mistaken for a record of what
happened.

This exact shape has been paid for here before:

- **VTID-03578** — `resolvePollyVoice()` ended `?? POLLY_VOICES['en']`, so
  Portuguese and Polish users were read to in fluent **English** by a voice that
  logged nothing and returned healthy audio. The module's own header called that
  failure worse than silence, one screen above the line that caused it.
- **`live-api-voice.ts`** hit the same problem and solved it properly, with a
  `fallback_lang` field and a one-shot `[voice-fallback]` log. The Nova path
  never got that treatment.

---

AC-1 — A substitution reports itself. `resolveNovaSonicVoiceOrFallback()`
returns `{ voice, fallback }` instead of a bare id, and reports `fallback: true`
for exactly the languages `NOVA_VOICES` has no row for (`ru pl sr ar zh`) and
`false` for the ones Nova actually speaks (`en de fr es pt`).
TEST: `test/orb/live/voice/nova-sonic-voice-fallback.test.ts` →
"reports fallback=true for every language with no native Nova voice",
"reports fallback=false for languages Nova actually speaks"

AC-2 — **Which voice is served is deliberately unchanged.** The bug is the
silence, not the choice: Nova publishes no `ru`/`pl`/`sr` voice, so there is
nothing better to switch to, and `pl` and `sr` are confirmed working with `tina`
in production today. Refusing to resolve would break two working languages to
fix a visibility problem. `tina` is also already the knowing house choice for
English (VTID header, 2026-07-28 live listen: the native `tiffany` was
rejected), so this is the same substitution the product already ships
deliberately. If it ever changes, that is a product decision about how `ru`,
`pl` and `sr` SOUND, and it should break a test loudly rather than drift.
TEST: `test/orb/live/voice/nova-sonic-voice-fallback.test.ts` →
"does NOT change which voice is served — pl and sr work today on tina"

AC-3 — The underlying resolver's `null` contract is preserved. Other callers
read `null` as "no native voice"; the new wrapper must not have absorbed that
meaning by wrapping it.
TEST: `test/orb/live/voice/nova-sonic-voice-fallback.test.ts` →
"preserves the null contract of the underlying resolver"

AC-4 — The log is rationed and locale-tag-insensitive: one `[voice-fallback]`
line per language per process, not one per session, mirroring
`live-api-voice.ts`. `ru`, `ru-RU` and `RU` are one language, not three. The
message names the CONSEQUENCE — "German accent" — because "using tina" tells a
reader nothing about what the user actually hears.
TEST: `test/orb/live/voice/nova-sonic-voice-fallback.test.ts` →
"logs the substitution once per language, not once per session",
"normalises locale tags so ru-RU does not log twice"

AC-5 — The call site no longer uses a bare `??`, and emits `nova_voice_fallback`
telemetry so the substitution is measurable in `oasis_events`, not only greppable
in logs. A unit test of the resolver cannot see the call site, and the call site
is where this was wrong for months — so the source is asserted directly, the same
way this repo guards other wiring it has been burned by (VTID-03531). All four
seams mutation-verified: forcing `fallback: false` fails 1, removing the dedupe
latch fails 2, removing locale normalisation fails 1, and reverting the call site
to `?? 'tina'` fails 1 (see `outputs/mutation.txt`).
TEST: `test/orb/live/voice/nova-sonic-voice-fallback.test.ts` →
"the call site no longer uses a bare ?? fallback"

---

## Route markers (VALIDATOR-CHECK exit 70/71/72)

The gate requires these because the diff touches a file under
`services/gateway/src/routes/`. It keys on the **file path**, not on whether a
route actually changed — and this change adds none, so the honest answers are
negative ones. They are recorded rather than fabricated:

ROUTE_MOUNT: **None — no route added, removed, or remounted.** The only edit to
`routes/orb-live.ts` is inside `connectToLiveAPI()`, the existing
already-mounted Nova upstream-connect path: one voice-resolution expression and
a fallback branch, ~26 lines at L7772. `git diff` shows no `router.get`/`.post`/
`.use` change of any kind.

FINAL_URL: **Unchanged.** No new or altered URL. The affected code runs behind
the existing ORB live transports (`/api/v1/orb/live/ws` and the SSE session
path); their paths, methods, auth and response shapes are byte-identical before
and after this change.

CURL_PROOF: **Not applicable, and deliberately not fabricated.** There is no
endpoint whose response differs — the change alters which *voice id* is sent on
an outbound Bedrock bidirectional stream and adds a log line plus a diag event.
`curl` cannot observe any of that. Two things prove it instead: (1) the suite in
`test/orb/live/voice/nova-sonic-voice-fallback.test.ts`, including a source-level
assertion on the call site itself, all four seams mutation-verified
(`outputs/mutation.txt`); and (2) after deploy, `nova_voice_fallback` in
`oasis_events` — a signal that did not previously exist, which is the entire
point of the change. Note also that exercising this against production is
forbidden outright by CLAUDE.md's standing rule, so a live curl was never an
available form of evidence here.

## OASIS traceability (VALIDATOR-CHECK exit 80/81)

OASIS_PROOF: This change **adds one new OASIS signal and alters none**.
`emitDiag(session, 'nova_voice_fallback', { provider, lang, voice, reason })`
is emitted into the existing `orb.live.diag` topic from
`routes/orb-live.ts`'s Nova connect path, exactly once per session whose
language has no native Nova voice. `nova_voice_fallback` is a **new** stage
value in that topic's vocabulary — no existing topic, stage or payload shape is
renamed or removed, so no dashboard or query that works today can break.

That is deliberately the *point* of the VTID rather than a side effect: before
this change the substitution produced no OASIS record at all, which is why
`ru`/`sr`/`pl` sessions could be served a German voice for months without
anything to query. The counterpart signal is the once-per-language
`[voice-fallback]` log line; the log says "this deployment substitutes for
Russian", the diag says how often and for whom.

**Honest limit on this proof:** the emit is verified by the test suite and by
reading the wired call site — it has **not** been observed in a live
`oasis_events` row, because the code is not deployed yet and this repo's
standing rule forbids exercising production to produce one. The first real
confirmation is a `nova_voice_fallback` row after deploy; per the VTID-03681
precedent, terminalization waits for that rather than being claimed at merge.

VTID-03682 is `status=in_progress`, `spec_status=approved` (user-instructed in
conversation, per §4.1).

---

## What this does NOT do

- **It does not make `ru` work.** `ru` emits ~11 audio chunks / **172 ms**
  (`model_start_speaking` 13:06:02.851 → `turn_complete` 13:06:03.023) against
  `pl` 628 ms / 46 chunks and `de` 646 ms / 46 on the identical code path, and
  two of three sampled `ru` sessions never spoke at all. This VTID **eliminates
  the voice as the explanation**: `ru`, `pl` and `sr` all resolve to `null` and
  all receive the same `tina`, yet `pl` and `sr` work — so whatever discriminates
  `ru` is not the voice. Also eliminated: "Nova cannot do unlisted languages"
  (`pl`/`sr` are unlisted and work) and Cyrillic (`sr` is Cyrillic and works).
  The discriminator is still unknown and needs either `polly:SynthesizeSpeech` on
  `claude-code-aws-agent` for a speech-fed probe, or CloudWatch on one live `ru`
  session.
- **It does not correct the `voice` field on `vtid.live.session.start`.** That
  field stays Gemini-lineage for every Nova session — including `en`/`de`/`fr`/
  `es`/`pt`, where a real native Nova voice IS resolved and the recorded name is
  still wrong. That is a defect in the session-start emit, not something the
  `?? 'tina'` operator caused, and fixing it means deciding what the field is FOR
  now that two voice systems coexist. Folding it in here would have changed a
  field every existing ORB dashboard reads, under a VTID whose whole premise is
  that audible behaviour must not move. Own VTID.
- **It does not decide what `ru`/`sr`/`ar`/`zh` should sound like.** Nova has no
  speech-to-speech voice for any of them and, with Vertex Live dead, no other
  provider is wired. Whether to keep the German substitute, serve English
  deliberately, or find a provider is an open product decision — this change
  makes the cost of that decision visible for the first time, which is the
  precondition for taking it.

## Also observed while measuring, unrelated and unfixed

**44 `nova_validation` content-filter blocks in 3 hours**, hitting `de` and `pl`
as well as the guided-topic sessions the VTID-03647/03674/03675/03677 chain has
been chasing. That is substantially noisier than the "34 over 3 days" recorded in
that chain's changelog rows. Flagged here so it is not lost; it is not this
VTID's scope.
