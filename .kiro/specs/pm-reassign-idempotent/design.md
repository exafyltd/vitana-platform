# Design — pm-reassign-idempotent
See `plan.md` "Change": a writer-level no-op guard (primary, reads the branch it writes), a stale-ready target that is
never the lane's `reviewer_seat` (amendment), a writer check that refuses `seat == reviewer_seat`, the
`'written' | 'noop'` writer result, and the staging env pin. The earlier decide-level `stale_review` guard is dropped
(round 1, R1-F1).

Stale-ready target (`decide.ts`):
```ts
const rotation = state.rotations.find((r) => r.area === lane.area)?.seats ?? [];
const idx = rotation.indexOf(lane.seat);
const seat = idx < 0 ? undefined : rotation.slice(idx + 1).find((s) => s !== lane.seat && s !== lane.reviewer_seat);
const next = seat ? { actor: seat, fallback: false } : claudeOrExceptions(claude);
if (next.actor === lane.seat || (next.actor !== 'claude' && next.actor === lane.reviewer_seat)) return null;
```
(`idx < 0` keeps today's behaviour: straight to `claudeOrExceptions`.)
