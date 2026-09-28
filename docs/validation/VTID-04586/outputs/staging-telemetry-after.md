# VTID-04586 — staging measurement after merge (AC-7)

Staging gateway build-info served `ea0ccbf43a6b` on 6/6 samples (2026-09-26 ~08:01 UTC)
before the runs. Two batches of 6 trials each,
`scripts/orb/measure-orb-first-audio.mjs --auth --lang=en --route=/command-hub --trials=6`,
test account, staging only. Raw output: `staging-benchmark-after.json`,
`staging-benchmark-after-2.json`.

## First model audio (client-measured, from session start)

| | trials with audio | min | p50 | p90 | max |
|---|---|---|---|---|---|
| Before (8fa030b) | 6/6 | 4,050 | 4,904 | 7,910 | 7,910 |
| After, batch 1 | 5/6 | 3,795 | 3,910 | 4,809 | 4,809 |
| After, batch 2 | 6/6 | 3,151 | 3,820 | 8,292 | 8,292 |
| After, pooled | 11/12 | 3,151 | 3,888 | 4,809 | 8,292 |

Reference: pre-VTID-04560 Command Hub median 3,270 ms.

## Telemetry, all 11 sessions that spoke

- `orb.live.tool.executed` / `stage=tool_call` on turn 0: **none** (before: `dev_system_status({fresh:true})` on most opens).
- `greeting_gather_awaited`: **none** (before: 350–470 ms on every open).
- `greeting_dispatched` with `wake_opener: work_surface_open` at 148–592 ms from upstream open, `directive_chars` 1,077.
- `greeting_sent` → first Nova transcript event: 1.8–2.9 s on 10 sessions, 7.1 s on one
  (`live-a5668a6a…`, batch 2 trial 6) — Nova silent after the greeting, with no tool call and no gather in between.

What remains between greeting and first audio is Nova composing its opener; the gateway no longer waits on anything.

## The one session without audio

`live-11b7bbcd…` (batch 1 trial 2): `nova_stream_error` "The system encountered an unexpected error
during processing" before the greeting was sent (`greeting_sent:false`, `audio_out:0`), then
`nova_validation` `prompt_protocol` on teardown. First occurrence of that Bedrock-side error in
7 days (0 in ~580 prior sessions); batch 2 did not reproduce it. Not caused by this change, which does
not touch the Nova stream.
