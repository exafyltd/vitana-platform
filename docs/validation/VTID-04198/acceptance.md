# VTID-04198 / VTID-04199 — iPhone: the orb says Vitana is speaking and no audio plays

## Reported

Platform owner, live on an iPhone (iOS 16.6, Appilix wrapper "App96"),
2026-09-19, pre-login `/maxina`:

> "I select German language press the ORB and it display Vitana talking but no
> Audio, zero!!! I select Russian, it displays Vitana Talking, but the German
> voice says: Maxina — instead of the introduction speech."

## What the logs actually show (read-only, `oasis_events`)

The reporting device is identifiable by user agent; the reported sequence
(de → de → sr → ru → ru, including the repeated Russian attempt) is user
`67c971fc…` at 10:28–10:29 UTC.

| session | lang | audio chunks | speech tokens | note |
|---|---|---|---|---|
| `58373903` | de | **315** | 643 | healthy greeting, `greeting_bridge_sent` |
| `750b9490` | de | 22 | 45 | retry 12 s later |
| `ff004e73` | ru | 16 | 33 | `nova_voice_fallback voice=tina` |
| `542847ae` | ru | 15 | 31 | `nova_voice_fallback voice=tina` |

Two independent faults.

**German — the audio was sent and the phone discarded it.** Session
`58373903` streamed 315 audio chunks / 643 speech tokens: a complete, healthy
greeting. Every server-side diagnostic for that session reports success. The
user heard nothing.

**Russian — Nova cannot speak it.** `/api/v1/orb/nova-sonic/health` on the
live production gateway (commit `a4dd71a`) reports
`"supported_languages": ["en","de"]` and `"cascade": {"enabled": false,
"effective": false, "languages": {"ru": "cascade:ru-RU"}}`. `ru` would be
cascade-eligible via Polly, but `ORB_CASCADED_VOICE_ENABLED` is not true on
the production task definition, so `ru` is forced onto Nova, which has no
Russian voice and substitutes `tina` — Nova's **German** voice, per
`nova-sonic-voice.ts`'s own `NOVA_SONIC_FALLBACK_VOICE` comment. That is the
"German voice", and 15 chunks is roughly one word.

The Russian half is a production environment change, not code, and is
**deliberately not addressed in this PR** — see "Not addressed" below.

## Root cause of the German half (this PR)

`orb-widget.js`'s `_processQueue()` suspended-context branch, two defects:

**(a) the retry loop could stop mid-flight.** It re-entered only via
`resume()`'s own `.then`/`.catch`, or when another chunk arrived. On iOS a
`resume()` issued without user activation can stay **pending** — never
resolving, never rejecting — and once the greeting finished streaming there
was no further chunk to drive the loop either. Both re-entry paths dead, the
retry simply stopped: no playback, and not even the 3 s give-up that would
have shown the tap-to-hear prompt. The overlay sat on "Vitana spricht…" in
silence, which is exactly how the report presented ("displays Vitana talking
but no Audio").

**(b) the give-up branch emptied the queue.** `_s.audioQueue.length = 0`
defeated the recovery VTID-03469 added in the same change: the prompt says
"tap to hear", the tap unlocks the context and calls `_processQueue()` —
against a queue whose greeting had already been thrown away. The prompt was
honest about the problem and structurally incapable of fixing it.

**And none of it was visible server-side.** `_announceAudioBlocked()` wrote a
`console.error` on a phone with no console attached and sent nothing to the
gateway, so the most user-visible ORB failure was the one failure mode with
no signal at all — unmeasurable, un-alertable, and unconfirmable after the
fact without physically holding the device.

## Acceptance criteria

AC-1 — `_processQueue` drives its suspended-context retry from its own timer,
so re-entry does not depend on `resume()` settling or on another chunk.
TEST: `services/gateway/test/frontend/orb-widget-ios-audio-blocked.test.ts`
("drives the suspended-context retry from its own timer, not only from
resume() settling")

AC-2 — the give-up branch no longer discards queued audio, so the
tap-to-hear prompt can actually replay the greeting.
TEST: `services/gateway/test/frontend/orb-widget-ios-audio-blocked.test.ts`
("no longer discards the queued audio when it gives up")

AC-3 — the held queue is bounded at the push site, keeping the EARLIEST
chunks so recovery plays the greeting from its first word.
TEST: `services/gateway/test/frontend/orb-widget-ios-audio-blocked.test.ts`
("bounds the held queue at the push site, keeping the earliest chunks")

AC-4 — the retry tick is cancelled on give-up, on success and on teardown, so
it cannot resurrect a closed AudioContext.
TEST: `services/gateway/test/frontend/orb-widget-ios-audio-blocked.test.ts`
("cancels the retry tick on give-up, on success, and on teardown")

AC-5 — the widget reports a playback block to the gateway, keyed to the
session, with keepalive so it survives the overlay closing.
TEST: `services/gateway/test/frontend/orb-widget-ios-audio-blocked.test.ts`
("beacons the block to the gateway, keyed to the session")

AC-6 — a real recovery is distinguished from the user giving up, so rescues
are not over-counted by exactly the population the beacon exists to measure.
TEST: `services/gateway/test/frontend/orb-widget-ios-audio-blocked.test.ts`
("distinguishes a real recovery from the user giving up")

AC-7 — the new route accepts ANONYMOUS callers, because the reported failure
is pre-login and its `audio-ready` sibling refuses anonymous.
TEST: `services/gateway/test/routes/orb-audio-blocked-route.test.ts`
("accepts ANONYMOUS callers — the reported failure is pre-login")

AC-8 — the route emits a queryable OASIS event and allowlists `state` rather
than echoing client text into a topic suffix.
TEST: `services/gateway/test/routes/orb-audio-blocked-route.test.ts`
("emits an OASIS event so the failure is queryable", "allowlists `state`
instead of echoing client text into a topic")

AC-9 — the route never hands an error to a client that is already degraded.
TEST: `services/gateway/test/routes/orb-audio-blocked-route.test.ts`
("never hands the client an error while it is already degraded")

AC-10 — VTID-03469's honest-UI guarantee still holds: the give-up branch
still announces.
TEST: `services/gateway/test/frontend/orb-widget-gesture-audio-unlock.test.ts`
("surfaces blocked audio instead of silently dropping the queue")

## Route mount

ROUTE_MOUNT: `router.post('/session/:id/audio-blocked', optionalAuth, …)` in
`services/gateway/src/routes/orb-live.ts`, mounted under the existing
`/api/v1/orb` router (same router as its `/session/:id/audio-ready` sibling,
which is already live at that prefix).

FINAL_URL: `https://preview-aws-gateway.vitanaland.com/api/v1/orb/session/:id/audio-blocked`

CURL_PROOF: verified BEFORE this PR deploys, against the live staging gateway,
that the path does not yet exist and returns Express's HTML 404 — the
diagnostic CLAUDE.md §15 prescribes for "route does NOT exist on deployed
code". Full transcript in `outputs/curl-route-before-deploy.txt`:

```
$ curl -s -o /dev/null -w '%{http_code} %{content_type}' -X POST \
    https://preview-aws-gateway.vitanaland.com/api/v1/orb/session/probe-vtid-04198/audio-blocked \
    -H 'Content-Type: application/json' -d '{"state":"blocked"}'
404 text/html; charset=utf-8
```

The same call must return `200 application/json` with `{"ok":true}` once this
merges and the staging deploy completes — that is the post-merge check, not a
claim made here.

## OASIS impact

OASIS_IMPACT: yes — three new event types are emitted:
`orb.live.audio_blocked`, `orb.live.audio_blocked.recovered`,
`orb.live.audio_blocked.abandoned`, registered on `CicdEventType`
(`services/gateway/src/types/cicd.ts`).

OASIS_PROOF: these are genuine state transitions, not telemetry loops — each
marks a decision point in one session's playback lifecycle (audio was
discarded / the prompt rescued it / the user abandoned it), emitted at most
once per state change per session by the widget's `_audioBlockedBeaconSent`
latch. They are not heartbeats and not polled. The emission is
fire-and-forget (`.catch(() => {})`), so a telemetry failure cannot degrade a
session that is already degraded. Payload shape and bounding are pinned by
`services/gateway/test/routes/orb-audio-blocked-route.test.ts`.

## Verification

See `commands.log`. Summary:

- `node --check orb-widget.js` — clean
- `tsc --noEmit` — clean apart from the pre-existing missing
  `@aws-sdk/client-cloudwatch-logs` package (present on `main` too)
- Full gateway jest suite **with** these changes: 45 failed suites, 16 failed
  tests, **16,029 passing**
- Full gateway jest suite with these changes **stashed** (baseline): 45 failed
  suites, 16 failed tests, 16,011 passing
- Identical failure counts; all 117 failures trace to that one missing
  package. This work adds 2 suites / 18 tests, all passing, and regresses
  nothing.

## Not verified — stated plainly

- **No real-device confirmation.** This session has no iPhone. The fix is
  verified structurally against the exact failure the production telemetry
  shows, not observed playing audio on the reporting device. The real signal
  is the reporting user's next pre-login German session actually producing
  sound.
- **The iOS unlock path itself was not proven to be what fired.** It is the
  only code path that produces "UI says speaking, zero audio", and it emits
  nothing server-side — which is precisely the gap VTID-04198 closes. After
  this deploys, `orb.live.audio_blocked` appearing in `oasis_events` for an
  iPhone session is the confirmation; its absence would mean the discard
  happened somewhere else and the hunt continues.

## Not addressed (deliberately)

**Russian speaking with a German voice.** Root-caused above and fully
evidenced, but the fix is `ORB_CASCADED_VOICE_ENABLED=true` on the
`vitana-gateway-awsdr` production task definition via
`AWS-PROD-DEPLOY-GATEWAY.yml`'s own workflow input — a production environment
change, not code, and one that needs `transcribe`+`polly` IAM on the task
role confirmed FIRST (the ordering discipline IF-THEN 31 already requires for
Bedrock). Staging already pins it `true`, which is why this never showed up
there. Raised for the platform owner rather than actioned unilaterally.
