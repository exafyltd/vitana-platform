# VTID-03764 — diagnostic instrumentation for the Nova context-upgrade-reconnect latency gap

Follow-up to VTID-03741. Real staging measurements (Playwright + the
`voice.latency.measured` telemetry VTID-03741 enabled) across 20 sessions
show a clean bimodal split: single-connection sessions land at 2.2-2.8s
total tap-to-first-audio (under the 3s target); sessions that reconnect
once to upgrade from an empty context (context-ready-gate timed out) to
the real ~27,500-char brain context land at 6.3-7.7s (over target). No
Nova errors/retries are logged for either case. The reconnect handshake
itself only costs ~150-350ms — the real, unexplained cost is a ~5s gap
between `greeting_sent` and `audio_out_first_chunk` with zero
instrumentation inside it. This VTID adds that instrumentation. It does
NOT attempt a fix yet — fixing blind, in this exact fragile
reconnect/greeting-resend code, is what the VTID-03674->03686 chain got
burned by repeatedly.

AC-1 — Two new diagnostic timing marks bisect the previously-opaque gap

`NovaSonicLiveClient` gained two optional, best-effort callbacks:
`onFirstRawChunk` (fires once, on the first raw eventstream chunk received
from Bedrock, regardless of content) and `onFirstNormalizedEvent` (fires
once, on the first normalized event of ANY kind — audio, text, toolCall,
ignored). Wired into `session.establishLatency` as two new `LatencyPhase`
values (`nova_first_raw_chunk`, `nova_first_normalized_event`) in the same
`voice.latency.measured` OASIS event VTID-03741 already emits.

TEST: `services/gateway/test/orb/live/upstream/nova-sonic-live-client.test.ts`
— "onFirstRawChunk and onFirstNormalizedEvent each fire exactly once, on
the FIRST event only".

AC-2 — The diagnostic hooks can never destabilize a real voice session

Both hooks are wrapped in try/catch at the call site; a throwing hook logs
nothing to the user-facing path and audio delivery continues unaffected.

TEST: same file — "a throwing onFirstRawChunk/onFirstNormalizedEvent never
destabilizes the stream" (asserts real audio still arrives at the client
even when both diagnostic hooks throw).

## What this VTID deliberately does NOT do

No fix is attempted here. The two competing hypotheses this instrumentation
exists to distinguish:
1. Nova itself is silent for ~5s after receiving the upgraded (real,
   ~27,500-char) context before producing anything — genuine external
   model latency, not something this codebase controls.
2. Nova responds quickly with SOMETHING (a raw chunk / a non-audio
   normalized event) but our own code is slow to turn that into audio the
   client hears — a real, fixable bug.

Next step: deploy this to staging, take several more real spaced-out
measurements, and read the new marks to tell these apart before writing
any fix.
