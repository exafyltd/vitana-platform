# Acceptance — VTID-05387 (operating-workflow/pm-noop)
Change types: Backend, Infrastructure/CI

| Criterion (tasks.md) | Evidence |
|---|---|
| Two PM ticks over the same lane write once, then nothing | `reassign-idempotent.test.ts` "write once, then zero; the second act reports unchanged" (1 put; `reassigned` then `unchanged`) |
| Writer skips the PUT on W1 and W2; a noop creates no branch or PR | `reassign-idempotent.test.ts` W1/W2/noop cases; `writers.ts` `laneChangeIsNoop` before `applyLaneChange` |
| `writeFile` skips an unchanged text | `reassign-idempotent.test.ts` "writeFile skips an unchanged text" |
| No PM write changes a lane permission key (R1-F3) | `reassign-seat.test.ts`: `applyLaneChange` throws on a seat change; `actReassign`/`actPark` pass no `seat`; stale-ready decisions are written as next_actor only |
| Lane scope rejects a pm-agent seat change (the path the guard avoids) | `commands.log`: `queue.mjs scope-check` on a fixture branch whose pm-agent commit changes `seat` → error |
| A staging deploy leaves `PM_AGENT_ENABLED=false` | `AWS-STAGE-DEPLOY-GATEWAY.yml:1225` `"false"`; `kaf-staging-claude-available-wiring.test.ts` VTID-05387 block |
| New tests red on base, green on head | `red-on-base.txt` (14 failed / 22), `commands.log` (233/233 PM suites, 1538/1538 in 112 PM-related suites) |
| The PM is not re-enabled anywhere | only the staging pin changes, to `"false"`; production workflow untouched |

## Decisions taken
- `LaneFileWriter.write` returns `Promise<'written' | 'noop' | void>`: `void` counts as written so the existing simple
  recorders in tests stay valid; the production writer always returns `'written'` or `'noop'`.
- Existing tests whose contract changed on purpose (each marked `VTID-05387 … contract change on purpose`):
  `decide.test.ts` (next-seat stale-ready → no decision), `fallback.test.ts` T5 (→ no decision; the availability
  threading test now uses a stale review), `act.test.ts` (reassign writes `next_actor` only),
  `observe-live.test.ts` (no `seat` in a PM change), `kiro-autonomy-fallback-proof.test.ts` proof 3 (→ no decision,
  still never claude). Each still asserts the invariant it protected (never claude while unavailable, one log entry,
  allowed keys only).
- `actPark` no longer writes `seat` either (same R1-F3 reason); the exceptions seat picks a parked lane up by
  `next_actor`.
