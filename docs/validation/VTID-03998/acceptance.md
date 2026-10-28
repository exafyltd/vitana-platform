# VTID-03998 — Fix Serbian cascade voice: Fish TTS `latency:'normal'` was starving the 30s greeting watchdog

## Report

Platform owner, live on `preview-aws.vitanaland.com/_intro/maxina` (pre-login
intro voice flow): "check the logs, pre login does not work at all. no audio
speech. zero!!!!!" Separately, in the same round: German/English work well;
Spanish/French/Russian work but with "desastrous" latency (10s+); Serbian
"dont work at all" pre-login, and after login it "works, but with terrible
latency."

## Investigation

Queried `oasis_events` (project `inmkhvwdcuyhnxkgfvsb`) for the reported
session window. `oasis_events` has no `type` column — live-session
diagnostics are `topic='orb.live.diag'`/`orb.live.stall_detected` with the
real fields nested in `metadata` (`code`, `reason`, `session_id`, `lang`,
`turn_count`, `diagnostic`).

Found **every** `sr` (Serbian) cascade session in the last 6 hours (4 total,
2 with full traces) following the identical pattern:

```
T+0.0s   session_start_anonymous
T+0.0s   vtid.live.session.start (x2)
T+0.1s   orb.live.diag (turn_count=0)   -- session setup only
         ... 30 seconds of NOTHING ...
T+30.0s  orb.live.diag reason=greeting_timeout   -- the pre-existing
         30s stall watchdog fires because no audio has ever been produced
T+30.0s  orb.live.stall_detected reason=greeting_timeout
T+30.0s  orb.live.diag reason=terminated          -- session torn down
T+30.2s  orb.live.diag code=cascade_tts_failed    -- the ACTUAL turn error,
         arriving AFTER teardown already started
```

(`live-787dde7b-f3c3-4a62-ac79-12090d987c5f`, `live-b77bfb48-9395-400b-
aef8-e32aff378c97`, both 2026-09-17, both pre-login/anonymous, both
`lang=sr`.)

`cascade_tts_failed` is raised by `CascadedLiveClient.runTurn()`
(`cascaded-live-client.ts`) when `synthesizeCascadeReply()` (Polly-first,
Fish-fallback — see VTID-03987) returns null for both backends. For `sr`,
Polly has no voice at all (`resolvePollyVoice('sr')` is null, confirmed
repeatedly in CLAUDE.md §2c/§2c-fish), so success depends entirely on Fish.

The error firing ~0.2–1.2s AFTER the independent 30s stall watchdog already
tore the session down — on **every** sr session observed, not sporadically
— means `runTurn()`'s combined LLM-completion + Fish-synthesis time was
running right up against (or past) the session's own 30s budget. Fish's own
request has a hard `FISH_REQUEST_TIMEOUT_MS = 15_000` abort. Given the
platform owner's own live report that the LLM-completion leg alone already
costs 10s+ for Polly-backed cascade languages (ru/es/fr — same
`callViaRouter('operator', ...)` call every cascade language shares), a
Fish call that is itself slow enough to approach its 15s cap accounts
for the total exceeding 30s for `sr` specifically, while Polly-backed
languages (whose TTS leg is near-instant) stay under the watchdog, just
with bad latency — matching "es/fr/ru work, terrible latency" vs "sr:
zero."

**Root cause in `fish.ts`:** the TTS request body sent `latency: 'normal'`
to Fish Audio's API. Per Fish's own docs (`docs.fish.audio` TTS reference):
`'normal'` is the **best-quality, slowest** setting (the documented
default); `'low'` is the lowest-latency option, `'balanced'` a middle
ground. For a real-time voice fallback with a hard 15s/30s budget, `'normal'`
is the wrong choice — Serbian is the ONLY language routed through Fish at
all, so a slow Fish call is a total outage for that language, not merely
lower quality.

## Fix — Fish-scoped only

Per the platform owner's explicit, standing instruction this session ("you
should not touch the solution for AWS Nova2Sonic and Polly we have in
place... everything you edit is only allowed for FISH Audio") and the
Nova/cascade-isolation + Polly/Fish shared-pipeline boundary formalized in
VTID-03987 (CLAUDE.md §2c-fish-scope: a change inside `fishBackend`/
`synthesizeFish()` itself is backend-local and Fish-only work never needs
to touch Polly or the shared STT/turn-gating pipeline), this fix touches
**only** `services/gateway/src/services/tts/fish.ts`:

`latency: 'normal'` → `latency: 'low'` in the Fish TTS request body.

No change to `cascaded-live-client.ts`, `tts-backend.ts`, `polly.ts`, Nova
Sonic, or the shared LLM-completion call — those are explicitly out of
scope for this VTID. The LLM-completion latency the platform owner also
reported (affecting ru/es/fr too) is a separate, shared-pipeline concern
flagged here for a future VTID, not fixed in this one.

## Acceptance Criteria

AC-1 — the Fish TTS request body requests `latency: 'low'`, not the
default `'normal'`.

TEST: `test/tts/fish-provider.test.ts` — `requests latency="low", not the
slower "normal"/"balanced" modes (VTID-03998)`.

AC-2 — every pre-existing Fish/cascade behaviour (gating, voice resolution,
error degradation, timeout handling, the Polly-first/Fish-fallback
selection order) is unchanged — this is a one-field request-body change,
not a behavioural rewrite.

TEST: `outputs/jest-fish-and-cascaded.txt` — all 7 pre-existing suites (62
tests) pass unmodified except the one updated assertion file.

## Verification

TEST: `outputs/tsc-noemit.txt` — `tsc --noEmit`, clean (exit 0).

TEST: `outputs/jest-fish-and-cascaded.txt` — Fish + cascaded suites, 7/7
suites, 62/62 tests passing, 0 regressions.

TEST: `outputs/npm-build.txt` — `npm run build`, clean (exit 0).

TEST: `outputs/jest-full-suite.txt` — full gateway suite: 934/935 suites (1
pre-existing skip), 15,290/15,325 tests passing, 0 failures.

## Not yet independently confirmed

This is a request-parameter change to a real third-party API whose timing
characteristics this session cannot directly re-measure (no `FISH_API_KEY`
in this session's environment). The next real signal is the reporting
user's next pre-login Serbian session actually producing audio instead of
hitting `greeting_timeout`/`cascade_tts_failed` — and, more broadly,
whether `'low'` latency mode brings Fish's contribution to total turn time
low enough to consistently clear the 30s watchdog. If Serbian pre-login
sessions still fail after this ships, the next diagnostic step is checking
whether Fish is returning a real HTTP error (not just being slow) — this
fix only addresses the slow-synthesis hypothesis the production timing
evidence supports, not a credentials/config failure (which would show up as
an immediate, not a ~15s-delayed, `cascade_tts_failed`).

The separate, shared-pipeline latency issue (LLM-completion latency,
10s+ even for Polly-backed ru/es/fr) is explicitly NOT addressed by this
VTID — flagged as a follow-up, out of this session's Fish-only scope.
