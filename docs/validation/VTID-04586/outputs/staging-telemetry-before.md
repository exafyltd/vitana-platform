# Staging telemetry before the fix (gateway 8fa030b, 2026-09-25 ~20:18 UTC)

Six authenticated Command Hub sessions (test account, `--route=/command-hub`,
voice only, no writes). Read-only from `oasis_events`.

Per session (all six the same shape):

- `orb.session.profile.resolved`: surface `command-hub`, role `developer`, resolution `route`.
- `instruction_budget`: 24,461 bytes total (scaffold 12,161 + bootstrap 12,300), not trimmed —
  about half the size of a member session (40-51 KB). Instruction size is not the cause.
- `voice.latency.measured` (session live-89b73068…):
  - greeting_facts_awaited 0 ms
  - **greeting_gather_awaited 348 ms, kind `newday`, path `ladder`** — the member new-day
    overview is gathered although `work_surface_open` always wins and never reads it
    (the other two sessions: 375 ms, 466 ms).
  - greeting_dispatched at 555 ms, wake_opener `work_surface_open`, directive 1,030 chars.
  - **nova_early_event kind `toolCall` at 2,146 ms**, then `audio_out_first_chunk` at 3,466 ms.
- `orb.live.diag` stage `tool_call`: tools `["dev_system_status"]`, turn_count 0.
- `orb.live.tool.executed`: `dev_system_status`, args `{"fresh":true}`, 448–483 ms, result
  "LIVE SYSTEM SNAPSHOT (taken …".

So on most Command Hub opens the model re-fetches (fresh, bypassing the 90 s cache) the
snapshot it was given at session start, before saying its first word. The conduct block
says "Use them [dev_system_status / dev_domain_atlas] before you state a current fact",
and the opener states current facts.

Benchmark (6 trials): first model audio min 4,050 / p50 4,904 / p90 7,910 ms.
Before VTID-04560 (458a1dc, same benchmark, 4 trials): p50 3,270 ms.
