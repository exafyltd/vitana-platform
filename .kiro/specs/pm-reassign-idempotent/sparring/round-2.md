# Sparring round 2 — converged

Session: `1137b27d-01dc-49ab-89a5-ceff1a6c7c97` · plan hash `d44f3d942d4961cc93a43af968f6e5da6a333ea09a9a5eb930d8103f2a6cbb70`

## Summary

Both R1-F1 and R1-F2 were accepted and are addressed in the revised plan. The decide-layer guard was dropped (change 5), the writer-only guard remains (change 1), and the `write` return type change is explicitly called out (change 4). The amendment adds a second-cause fix (stale_ready target must not equal reviewer_seat) and a writer-level invariant. I verified the key premises of the revised plan against the pinned code and found them accurate. Two minor issues noted.

## Findings

### R2-F1 [minor]

The plan's `laneChangeIsNoop` function compares front-matter keys and the newest log entry text to decide a no-op. However, `applyLaneChange` (writers.ts:57) always sets `updated:` to the current timestamp via `setKey(fm, 'updated', isoMinute(nowIso))`. Because `nowIso` differs on every tick, the text produced by `applyLaneChange` will always differ from the file on the branch. The plan must make clear that `laneChangeIsNoop` compares the *semantic* keys (state, next_actor after LANE_ACTORS mapping, seat, claimed_by) and the last log text — but NOT `updated:` — before `applyLaneChange` runs. The plan reads this way, but an implementer could miss this subtlety and do a whole-text comparison, which would make the guard dead code.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/writers.ts:42` — fm = setKey(fm, 'updated', isoMinute(nowIso));
...
return `---\n${fm}\n---${body}### ${isoMinute(nowIso)} · ${PM_SESSION} · ${transition}\n${change.log}\n`;

Suggestion: Add an explicit note: `laneChangeIsNoop` must compare only the semantic keys (state, next_actor after LANE_ACTORS mapping, seat, claimed_by) and the last log line text — it must NOT compare `updated:` or the timestamp in the log heading, since those change every tick and would defeat the guard.

### R2-F2 [minor]

The `ActStatus` union in types.ts:425-442 does not include `'unchanged'`. The plan (change 4) says `actReassign` returns `status: 'unchanged'` when the writer reports `'noop'`, but this requires adding `'unchanged'` to the `ActStatus` type union. This is implied but should be explicitly listed as a type change alongside the `LaneFileWriter.write` return type change, since `ActResult.status` is typed as `ActStatus`.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/types.ts:425` — export type ActStatus =
  | 'merged'
  | 'already_merged'
  | 'merge_refused'
  | 'governance_blocked'
  | 'reassigned'
  | 'parked'
  | 'gate2_posted'
  | 'skipped_not_live'
  | 'skipped_no_lease'
  | 'verified_written'
  | 'branch_updated'
  | 'update_refused'
  | 'plan_merged'
  | 'ledger_updated'
  | 'ledger_failed'
  | 'act_error';

export interface ActResult {
  decision: PmDecision;
  status: ActStatus;
  detail?: string;
}

Suggestion: Explicitly mention that `'unchanged'` is added to the `ActStatus` union in `types.ts`.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed. The decide-layer guard was dropped (change 5). The plan now relies solely on the writer-layer noop guard, which reads from the bookkeeping branch and is effective during the hot loop. The remaining decide.ts change (change 2, stale_ready target rule) only needs seat/reviewer_seat which are already on ObservedLane — verified at types.ts:119-121.
- R1-F2: acknowledged — Accepted and addressed in change 4: `LaneFileWriter.write` returns `Promise<'written' | 'noop'>`, test fakes return `'written'`, `actReassign` maps `'noop'` to `status: 'unchanged'`.
