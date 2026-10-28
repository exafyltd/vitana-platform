# Sparring round 1 — in_progress

Session: `96fa58f8-75d5-4774-bb93-e67fc47f85d0` · plan hash `7a834d7625ab782acee92f54da07bcd199e1da93d26b0c1278050db3deeba51d`

## Summary

The plan is well-reasoned and addresses a real operational issue (PM agent spam loop). All seven premises verified against the pinned code. The noop detection design (change 1), the stale_ready reviewer_seat guard (change 2), the applyLaneChange defensive guard (change 3), the interface return type change (change 4), and the workflow env var fix (change 6) are sound in combination. I found one major concern regarding the applyLaneChange guard interacting with pre-existing bad state on bookkeeping branches, and two minor notes about implementation details.

## Findings

### R1-F1 [major]

Change 3's `applyLaneChange` guard (throw when resulting FM has `seat == reviewer_seat`) will block ALL PM writes (park, done, verify, not just reassignment) to any lane whose bookkeeping branch already carries the bad state. The plan lists four PRs (#4370, #4333, #4267, #4249) with this exact bad state as out of scope for closure. Until those branches are cleaned up, any non-noop PM write to those lanes (e.g., park due to CI failures) would throw, producing `act_error`. While the observer reads from main so the lane on main is unaffected, the guard makes this failure mode noisier and blocks future valid writes to those lanes on the bookkeeping branch. The noop check (change 1) only protects identical reassignment writes; a different decision type (park, stale_review next_actor-only change) on the same lane would bypass the noop check and hit the guard.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/writers.ts:43` — export function applyLaneChange(text: string, change: LaneFileChange, nowIso: string): string {
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/act.ts:419` — } catch (err) {
        results.push({ decision, status: 'act_error', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) });
      }
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/writers.ts:104` — const branch = await this.ensureBookkeepingBranch(repo, change.slug);
      const cur = await this.client.file(repo, path, branch);
      if (!cur) throw new Error(`${path} not on ${branch}`);
      const next = applyLaneChange(cur.text, change, this.nowIso());
      await this.client.put(repo, path, branch, next, cur.sha, commitMessage(`pm: ${change.slug}/${change.lane} ${change.state ?? 'update'}`, `${change.slug}/_plan`));
      await this.ensureBookkeepingPull(repo, change.slug, branch);

Suggestion: Scope the guard to throw only when the *current change* introduces `seat == reviewer_seat` (i.e., `change.seat` is defined and equals the existing `reviewer_seat`), not when the bad state is pre-existing. Alternatively, add a prerequisite step to close/delete the four known bad bookkeeping branches BEFORE deploying this change, and move that out-of-scope item into the lane's prerequisites.

### R1-F2 [minor]

The existing `FakeLaneWriter` in `act.test.ts` (line 82-87) implements `write` as `async (c): Promise<void>`. Changing the `LaneFileWriter` interface to return `Promise<'written' | 'noop'>` will cause a TypeScript compilation error in `act.test.ts`. While the plan states 'Test fakes and other implementations return written', the plan's test section only lists three new test files; it does not mention updating the existing `act.test.ts` fake.

- `exafyltd/vitana-platform:services/gateway/test/project-manager/act.test.ts:82` — class FakeLaneWriter {
    changes: LaneFileChange[] = [];
    write = async (c: LaneFileChange): Promise<void> => {
      this.changes.push(c);
    };
  }
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/act.ts:111` — export interface LaneFileWriter {
    write(change: LaneFileChange): Promise<void>;
  }

Suggestion: Add an explicit note that `act.test.ts`'s `FakeLaneWriter` (and any other existing test fakes implementing `LaneFileWriter`) must be updated to return `'written'`.

### R1-F3 [minor]

For the W2 noop path, `ensureBookkeepingBranch` (line 104) is called before the file is read, and `ensureBookkeepingPull` (line 109) is called after the `put`. The plan says noop means 'no commit, no push, no branch/PR creation'. The implementation must skip `ensureBookkeepingPull` on noop to avoid creating an empty PR. While `ensureBookkeepingBranch` is harmless (idempotent, and the first write to a fresh branch is never a noop), `ensureBookkeepingPull` would create a PR with no PM changes if called during a noop.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/writers.ts:104` — const branch = await this.ensureBookkeepingBranch(repo, change.slug);
      const cur = await this.client.file(repo, path, branch);
      if (!cur) throw new Error(`${path} not on ${branch}`);
      const next = applyLaneChange(cur.text, change, this.nowIso());
      await this.client.put(repo, path, branch, next, cur.sha, commitMessage(`pm: ${change.slug}/${change.lane} ${change.state ?? 'update'}`, `${change.slug}/_plan`));
      await this.ensureBookkeepingPull(repo, change.slug, branch);

Suggestion: Make explicit in the plan that on a noop, the W2 path must return `'noop'` after the `laneChangeIsNoop` check and before `client.put` and `ensureBookkeepingPull`.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
