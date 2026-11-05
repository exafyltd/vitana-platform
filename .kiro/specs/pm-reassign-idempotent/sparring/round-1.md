# Sparring round 1 — in_progress

Session: `1137b27d-01dc-49ab-89a5-ceff1a6c7c97` · plan hash `490abdc3a030896b24ca4e4d36ebab39948612c35e613764e62753b4da2b8d43`

## Summary

The writer-layer no-op guard (checking the bookkeeping-branch file before committing) is the correct and effective fix. However, the decide-layer guard described in the plan is based on incorrect assumptions about what the observer sees, and the `LaneFileWriter` interface needs a return-type change the plan doesn't mention.

## Findings

### R1-F1 [major]

The decide-layer guard ('no decision when the lane's next_actor already equals the mapped target actor and the lane's last log entry is a PM reassign to that actor') is ineffective and based on wrong premises. (1) `ObservedLane` has no `next_actor` field — it has `seat`, `reviewer_seat`, `state`, etc. but not `next_actor` (types.ts:112-168). Adding it would require a type change and an observer change. (2) The observer reads all lane front matter and log entries from `main` (observe-live.ts:293-327, line 317 reads blobs from the main tree, line 373 parses the log from that text). W2 writes go to the bookkeeping branch `pm-agent/<slug>`, not `main`. So neither `next_actor` nor the PM reassign log entry is visible to the observer until the bookkeeping PR is merged — which is exactly the window where the loop occurs. The plan's claim 'the observation already carries the log' is wrong. This makes the decide guard dead code for the incident scenario. The writer guard alone is effective (it reads from the bookkeeping branch at writers.ts:105), but the decide guard as described requires additional type/observer changes AND still won't prevent re-decisions. Either drop the decide guard to keep scope tight, or have the observer also consult the bookkeeping branch head for `next_actor`/last-log (which significantly increases scope beyond 'light').

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/types.ts:112` — export interface ObservedLane {
  slug: string;
  lane: string;
  vtid: string | null;
  state: LaneState;
  seat: string;
  reviewer_seat: string;
  area: string | null;
  ...
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/observe-live.ts:293` — // 1. Specs on main.
const specLanes: SpecLane[] = [];
...
tree = await r.tree(repo, 'main');
...
const text = await r.blob(repo, t.sha);
const fm = parseFrontMatter(text);
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/observe-live.ts:433` — lanes.push({
  slug: sl.slug,
  ...
  seat: str(sl.fm.seat),
  reviewer_seat: str(sl.fm.reviewer_seat),
  ...
  state_since: sl.fm.updated ? isoOf(str(sl.fm.updated)) : new Date(nowMs).toISOString(),
  ...
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/writers.ts:104` — const branch = await this.ensureBookkeepingBranch(repo, change.slug);
const cur = await this.client.file(repo, path, branch);
if (!cur) throw new Error(`${path} not on ${branch}`);
const next = applyLaneChange(cur.text, change, this.nowIso());
await this.client.put(repo, path, branch, next, cur.sha, ...);

Suggestion: Drop the decide-layer guard entirely and rely solely on the writer-layer no-op guard (`laneChangeIsNoop`). This keeps scope 'light', avoids type/observer changes, and is the guard that actually works (it reads from the bookkeeping branch). Alternatively, if you want defence-in-depth, accept that the decide guard requires adding `next_actor` to `ObservedLane`, populating it in the observer, and acknowledging it only prevents re-decisions after the bookkeeping PR merges (not during the hot loop).

### R1-F2 [minor]

The `LaneFileWriter` interface defines `write(change: LaneFileChange): Promise<void>`. The plan says `actReassign` 'returns status: unchanged when the writer reports a no-op', but the current interface returns void — it cannot signal a no-op to the caller. The plan needs to change the interface return type (e.g. to `Promise<'written' | 'noop'>`), which also affects test fakes and other `LaneFileWriter` implementations.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/act.ts:111` — export interface LaneFileWriter {
  write(change: LaneFileChange): Promise<void>;
}
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/act.ts:279` — async function actReassign(decision: ReassignDecision, state: ObservedState, deps: Bound): Promise<ActResult> {
  const isLane = decision.target === 'lane';
  await deps.laneWriter.write({...});
  return { decision, status: 'reassigned', detail: `${decision.target}→${decision.to_actor}` };
}

Suggestion: Mention the interface change explicitly: `write` returns `Promise<'written' | 'noop'>` (or a similar discriminant). Update the existing test fakes to return the new type. Other callers (`actMerge`, `actPark`, `actVerify`) can ignore the return value.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
