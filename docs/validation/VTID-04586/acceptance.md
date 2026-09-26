# VTID-04586 — Command Hub voice latency regression from VTID-04560

Owner decision (2026-09-25): hold the VTID-04542 production publish until the
Command Hub slowdown VTID-04560 introduced is fixed on staging.

## What was measured (staging, before)

`outputs/staging-telemetry-before.md`, `outputs/staging-benchmark-before.json`.
Command Hub first model audio p50 4,904 ms (6 trials) against 3,270 ms before
VTID-04560. Two causes, both visible in `voice.latency.measured`:

1. **A tool call before the first word.** On most Command Hub opens Nova calls
   `dev_system_status({fresh:true})` on the greeting turn, then speaks ~1.3 s
   after the tool result. The session already carries that snapshot (its
   highlights are in the opener directive, its text in the work-surface
   context). The developer conduct rule "use them before you state a current
   fact" made the model re-fetch it.
2. **The member new-day gather runs on a work surface.** 350–470 ms of
   `greeting_gather_awaited kind:newday` before the greeting is dispatched,
   although `work_surface_open` outranks every ladder and never reads the
   payload.

## Change

- `overviewIndependentOpenerWins()` also returns true when the work-surface
  rung fires. All three gather sites (safe-fast plan, normal-ladder pre-guard,
  and so the greeting-facts wait behind it) already key off it (VTID-04544),
  so a work-surface session skips the member gathers entirely.
- `work_surface_open` directive: the facts are introduced as loaded when the
  session opened, current enough for this opening, speak from them and call no
  tool before the first reply. Intent only (NEVER rule 41).
- Developer conduct line: use the tools before stating a current fact **the
  live snapshot does not already cover, or once it is more than a few minutes
  old** — later turns still re-check.

Member surfaces are unchanged: every member scenario of the VTID-04542 payload
guard is byte-identical; only the Command Hub instruction snapshot moved
(12,171 → 12,272 bytes), re-recorded on purpose.

## Acceptance criteria

AC-1 A work surface (Command Hub developer, admin) skips the member payload gathers on both ladders.
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts ("VTID-04586: a work surface skips the member payload gathers")
AC-2 The member surface still gathers on both ladders.
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts ("VTID-04586: the member surface still gathers")
AC-3 The work-surface opener tells the model to speak from the loaded facts and call no tool first.
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts ("VTID-04586: the opener speaks from the loaded facts and calls no tool first")
AC-4 The developer conduct rule no longer demands a tool call for facts the snapshot covers.
  TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts ("VTID-04586: the developer conduct rule no longer demands a tool call …")
AC-5 Nothing else the voice provider receives changes; only the Command Hub instruction moves.
  TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts
AC-6 The VTID-04544 gather contract still holds.
  TEST: services/gateway/test/services/conversation/vtid-04544-greeting-payload-gather.test.ts
AC-7 (staging, after merge) Command Hub first model audio p50 back near the pre-VTID-04560 3.3 s,
  no `dev_system_status` tool call on turn 0, no `greeting_gather_awaited` on Command Hub sessions.
  Recorded in `outputs/staging-benchmark-after.*` once measured.
  CURL: https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info (serves the merge commit), then scripts/orb/measure-orb-first-audio.mjs --auth --lang=en --route=/command-hub --trials=6

Both fixes were mutation-checked: undoing each one fails its test (commands.log).

## OASIS

OASIS_IMPACT: no — no event topic, payload or emitter changes. The existing
`voice.latency.measured` / `orb.live.diag` events are only read as evidence.
