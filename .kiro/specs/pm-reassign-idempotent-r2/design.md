# Design — pm-reassign-idempotent-r2
Same design as `pm-reassign-idempotent/design.md` (converged): a writer-level no-op guard (reads the branch it
writes), a stale-ready target that is never the lane's `reviewer_seat`, a writer check that refuses
`seat == reviewer_seat`, the `'written' | 'noop'` writer result with `ActStatus` `'unchanged'` (`types.ts`), and the
staging env pin. Only the lane's executor and paths differ (see `plan.md` "Why a re-plan").
Stale-ready target (`decide.ts`):
```ts
const rotation = state.rotations.find((r) => r.area === lane.area)?.seats ?? [];
const idx = rotation.indexOf(lane.seat);
const seat = idx < 0 ? undefined : rotation.slice(idx + 1).find((s) => s !== lane.seat && s !== lane.reviewer_seat);
const next = seat ? { actor: seat, fallback: false } : claudeOrExceptions(claude);
if (next.actor === lane.seat || (next.actor !== 'claude' && lane.reviewer_seat && next.actor === lane.reviewer_seat)) return null;
```
(`idx < 0` keeps today's behaviour: straight to `claudeOrExceptions`.)
