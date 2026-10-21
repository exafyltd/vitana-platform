# VTID-04813 — Russian voice on the Vertex Live bridge

**Owner request, 2026-10-01:** *"Replace Tatyana voice with a Google voice
like for Serbian."* Follows the live report in VTID-04724: *"The Russian
voice is also like from a desperate old woman with zero energy. Terrible."*

VTID-04724 fixed the *language* fault (Russian sessions answering in
German). This VTID is the second, separate fault from the same report: the
*voice itself*.

---

## 1. Why Polly cannot fix this

`POLLY_VOICES.ru` is `Tatyana` on the `standard` engine. That is not a
configuration choice:

| Fact | Source |
|---|---|
| `DescribeVoices(ru-RU)` in `eu-central-1` returns exactly `Tatyana` and `Maxim` | live call, re-measured 2026-09-29 |
| **Both are `standard`-engine only** — no neural, no generative | same call |
| `ru` is the only language in `POLLY_VOICES` not pinned to `neural` | `services/tts/polly.ts` |
| The table's own comment has flagged this since VTID-03578: *"a quality step down from `ru-RU-Wavenet-A`, flagged rather than hidden"* | `services/tts/polly.ts` L84 |

"Zero energy" is an accurate description of Polly's `standard` engine. No
Polly setting closes the gap, so the fix had to move the pipeline, not the
voice id.

## 2. Why this copies Serbian rather than inventing something

| Precondition | Verified | How |
|---|---|---|
| Gemini Live speaks Russian | ✅ `ru` is in Google's own Live API supported-language table (99 languages) | `ai.google.dev/gemini-api/docs/live-guide`, checked 2026-10-01 |
| The bridge mechanism is proven in production | ✅ `VERTEX_SERBIAN_BRIDGE_ENABLED=true` is pinned in `AWS-PROD-DEPLOY-GATEWAY.yml` | the live workflow file |
| No new GCP provisioning needed | ✅ same project, same WIF cred config, same `VERTEX_AI_LOCATION` already pinned on **both** workflows | the live workflow files |
| Russian already has a correct Gemini voice | ✅ live `decision_policy` row `voice.live_api.voice.ru` = `{voice_name:"Aoede", fallback_lang:"en"}` — byte-identical to `sr`'s | read-only query, 2026-10-01 |
| That voice satisfies the persona voice-gender rule (VTID-04445) | ✅ `Aoede` is `female` in `GEMINI_VOICE_GENDER`, and Vitana's voice is female in every language | `orb/live/voice/persona-voice-gender.ts` |
| Devon still gets a male voice on this pipeline | ✅ `VERTEX_SPECIALIST_FALLBACK_VOICE = 'Charon'` (male), language-independent | `vertex-serbian-bridge.ts` |
| The Vertex tool-catalog byte budget applies | ✅ keyed on `session.upstreamProvider === 'vertex'`, never on language — `ru` inherits it automatically | `orb-live.ts` envelope builder (VTID-04026) |

**No DB change was needed or made.** Russian inherits a voice already
serving Serbian on this exact bridge in production.

## 3. The precondition CLAUDE.md sets, and how it is satisfied

`§2e-vertex-serbian-bridge` says: *"Before promoting this bridge past a
small canary, either backport the missing watchdogs into `VertexLiveClient`
**or confirm gateway-level timeouts elsewhere already bound it**."*

The second route holds, **verified in code rather than assumed**:

- `cleanupExpiredSessions()` (`orb/live/session/live-session-controller.ts`)
  and the `wsClientSessions` sweep (`routes/orb-live.ts`) both expire any
  session whose `lastActivity` is older than `SESSION_TIMEOUT_MS` (30 min),
  on a 5-minute interval.
- **Neither looks at the provider.** A Vertex session is bounded by them
  exactly as a Nova session is.

And by volume this is not a promotion past a canary at all — it is a
*smaller* canary than the one already running. Measured read-only in
production `oasis_events` (`greeting_sent` per language, 30 days to
2026-10-01):

| Language | Sessions | On the bridge? |
|---|---|---|
| de | 866 | no |
| en | 258 | no |
| **sr** | **136** | **yes, in production today** |
| **ru** | **18** | this VTID |
| fr | 3 | no |
| es | 1 | no |

Russian is **~7.5× smaller** than Serbian. Enabling it widens bridge
exposure by roughly 13%, not 8×.

**Still open and unchanged for both bridges:** the 7 missing OASIS topics
and the reconnect/connection caps from the same parity scan. Not introduced
here, not closed here, and recorded in `backend.md` so it is not mistaken
for resolved.

## 4. A separate switch, not a widened gate

`vertex-serbian-bridge.ts`'s own header promises its predicate is *"never
widened to a language list — one language, one narrow bridge, easy to delete
outright"*. Adding Russian to that predicate would have broken that promise.

Instead: a new file, `vertex-russian-bridge.ts`, with its own
`VERTEX_RUSSIAN_BRIDGE_ENABLED` switch and its own `ru`-only predicate. The
Serbian module is **untouched**. Consequences:

- Russian can be turned off without touching Serbian, and vice versa.
- Neither predicate is a list a third language could be quietly appended to.
- Deleting either bridge stays a one-file, one-flag operation.
- New `SelectionReason: 'vertex_russian_bridge'`, so telemetry never
  reports a Russian session as a Serbian one.

## 5. Scope — only the live voice session moves

`POLLY_VOICES.ru` is **deliberately unchanged**. `resolvePollyVoice('ru')`
still serves the non-conversational Russian TTS call sites — the `/orb/tts`
route, the reminder pre-render, guided-topic narration — which do not go
through Gemini Live. Removing Tatyana would break them. This changes the
voice of the *conversation*, which is what was reported, not every Russian
audio asset.

## 6. Acceptance criteria

AC-1 — The switch defaults OFF, so merging this changes nothing by itself.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "defaults to disabled — merging this file changes nothing on its own"

AC-2 — Only the exact string `'true'` enables it; every typo resolves to off.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "is enabled only by the exact string \"true\""

AC-3 — The language predicate matches `ru`, `ru-RU`, `ru_RU`, `RU-ru`.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "matches bare \"ru\"" + "matches region/script-tagged variants"

AC-4 — It refuses every other language, `sr` included.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "rejects every other language — including sr, which has its own bridge"

AC-5 — The Serbian predicate still refuses `ru`: it was not widened.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "the Serbian predicate still refuses ru — it was not widened to carry Russian"

AC-6 — Each switch controls only its own bridge.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "each switch controls only its own bridge"

AC-7 — A `ru` session resolves `provider: vertex` with `reason: vertex_russian_bridge`.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "fires for ru with its OWN reason, so telemetry never mislabels it Serbian"

AC-8 — A `sr` session still resolves `vertex_serbian_bridge`, unchanged.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "still reports vertex_serbian_bridge for a Serbian session — unchanged"

AC-9 — Both context fields must be explicitly true; an absent object cannot satisfy the gate.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "needs BOTH of its own fields true" + "an absent vertexRussianBridge object cannot satisfy the gate"

AC-10 — The bridge is checked BEFORE the cascade, so `ru` gets Gemini not Polly.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "is checked BEFORE the cascade"

AC-11 — With the flag off, `ru` keeps the existing cascade behaviour byte-for-byte.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "with the bridge off, a ru session keeps the existing cascade behaviour byte-for-byte"

AC-12 — A healthy Nova language never reaches Vertex, flag on or not.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-vertex-russian-bridge.test.ts` → "never routes a healthy Nova language to Vertex, even with the flag on"

AC-13 — The flag is pinned on BOTH deploy workflows, stripped before re-add.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-russian-bridge-wiring-pinned.test.ts` → "strips the var before re-adding it" + "re-adds it as the exact string true"

AC-14 — Pinning it does not create an auto-to-prod path.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-russian-bridge-wiring-pinned.test.ts` → "prod deploy stays manual-dispatch only"

AC-15 — The GCP project/location stay pinned with the flag, and the decommissioned project never appears.
TEST: `services/gateway/test/orb/live/upstream/vtid-04813-russian-bridge-wiring-pinned.test.ts` → "still pins the GCP project and location the bridge needs"

OASIS_PROOF: the selection reason reaches `oasis_events` — that is how
VTID-04000 recorded Serbian's own acceptance signal ("the real signal is the
next real `sr` session on staging reporting `reason:'vertex_serbian_bridge'`
in `oasis_events`"). This VTID adds no new OASIS topic and no new emission
site; it adds one new VALUE, `vertex_russian_bridge`, to the existing
`SelectionReason` union that those events already carry, so a Russian
session can be told apart from a Serbian one in telemetry. The read-only
query to confirm it after deploy:

```sql
SELECT created_at, metadata->>'session_id' AS sid,
       metadata->>'lang' AS lang, metadata->>'provider' AS provider,
       metadata->>'reason' AS reason
FROM oasis_events
WHERE topic = 'orb.live.diag' AND metadata->>'lang' = 'ru'
ORDER BY created_at DESC LIMIT 20;
```

## 7. Verification run

- `tsc --noEmit` — clean.
- New suites: **17 + 6 = 23 tests**, all passing.
- `test/orb/live/upstream` (the whole directory): **49 suites, 589 tests, 0 failures** — includes the untouched Serbian bridge suite and the VTID-03723 vertex-unavailable invariant matrix.
- **Mutation-verified, both halves independently:**
  - revert the selector wiring to Serbian-only → **2 tests fail** (AC-7, AC-10)
  - widen the `ru` predicate to also accept `sr` → **2 tests fail** (AC-4, AC-5)
- The VTID-03788 workflow guard caught a real problem mid-change: the prod
  `run:` step went **238 chars over GitHub's 20,000 limit**. Fixed by moving
  the rationale out of the workflow (it lives in the module header and
  `backend.md`) rather than by loosening the guard. Final headroom: 49 chars.

## 8. NOT verified — stated plainly

**No real Russian voice session has been heard on this bridge.** This
session cannot place an ORB call, and CLAUDE.md forbids testing against
production. What is proven is the routing decision, its gates, and that the
voice/gender/project/catalog preconditions all resolve correctly.

The real signal, after the flag is live, is a `ru` session in
`oasis_events` reporting `reason:'vertex_russian_bridge'` **and producing
audio** — the same acceptance signal VTID-04000 recorded for Serbian, and
the same one that remained outstanding for it until real traffic arrived.

A reasonable expectation to hold loosely: Gemini Live is a native
voice-to-voice model, so Russian should gain both expressiveness and a
latency drop (it leaves the three-hop Transcribe→Bedrock→Polly cascade).
Neither is measured here.
