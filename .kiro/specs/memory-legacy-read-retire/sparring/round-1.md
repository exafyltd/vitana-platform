# Sparring round 1 — in_progress

Session: `9a9f8767-1e12-478e-bf22-c7f07e8d16f4` · plan hash `e9a83c5dad585b7188a810410d649c4521d3c42fd128dffb7d22347842bb177e`

## Summary

The plan is well-structured and the core premises about the bridge's read path, shadow, and flag pins all hold against the pinned commit. The main gap is that the lane's declared file paths and test plan omit two test files that almost certainly exercise the legacy fallback being deleted, risking broken tests or—worse—silently loosened coverage without acknowledgement.

## Findings

### R1-F1 [major]

The lane's declared paths and test plan omit `services/gateway/test/services/orb-memory-bridge.test.ts` and `services/gateway/test/vtid-05147-effective-role-permitted.test.ts`, both of which reference `fetchMemoryContextWithIdentity`. These tests almost certainly exercise or mock the legacy fallback behaviour being deleted and will need updating, but they are not listed in the lane paths or test plan. If the implementor only touches the listed paths, these tests will either fail (blocking merge) or, if they happen to pass by accident, silently lose coverage of the new ok:false-only semantics.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-memory-bridge.ts:887` — if (identity && useRecall) {
      const recalled = await recallOrbMemoryItems(effectiveIdentity);
      if (recalled.ok) {
        return { ...buildOrbMemoryContextFromItems(...), read_path: 'recall' };
      }
      if (forcePath === 'recall') {
        return { ok: false, ... };
      }
    }
- `exafyltd/vitana-platform:services/gateway/src/services/orb-memory-bridge-repository.ts:1` — Every Supabase `.from(...)`/`.rpc(...)` call in orb-memory-bridge.ts now goes through here

Suggestion: Add `services/gateway/test/services/orb-memory-bridge.test.ts` and `services/gateway/test/vtid-05147-effective-role-permitted.test.ts` to the lane's paths list. In the test plan, explicitly state how each is updated (e.g. mocks adjusted to expect recall-only, legacy-fallback assertions removed or converted to ok:false assertions).

### R1-F2 [minor]

The plan says 'delete … the five unused repository fetchers (premise 4)' and lists `orb-memory-bridge-repository.ts` in the lane paths. That file also contains functions actively used by other bridge code (`fetchOrbConversationItems`, `fetchRecentOrbUserTurnsRaw`, `insertMemoryItem`, etc.). The plan should clarify that only the five legacy-read fetchers are removed, not the entire file, to prevent an implementor from deleting the whole module.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-memory-bridge-repository.ts:18` — export async function fetchOrbConversationItems(...)
export async function fetchRecentOrbUserTurnsRaw(...)
export async function insertMemoryItem(...)

Suggestion: Add a note: 'Only the five parallel-fetch functions are deleted from orb-memory-bridge-repository.ts; the remaining functions (fetchOrbConversationItems, fetchRecentOrbUserTurnsRaw, insertMemoryItem, etc.) are still used.'

### R1-F3 [minor]

The plan's premises section cites commit bf5e0c12d0b653238d896fc61cb7f1c150c9027e, but this review is pinned at 29b639da4bfcacce3200e2d1d08881c260c4e990. All checked premises hold at the pinned commit, but the mismatch means the plan was written against a different snapshot and should be re-pinned before the VTID is assigned.

- `exafyltd/vitana-platform:services/gateway/src/services/orb-memory-bridge.ts:887` — const useRecall = forcePath ? forcePath === 'recall' : isOrbRecallEnabled();

Suggestion: Update the premises section commit hash to the current pinned commit (29b639da) and re-verify line numbers.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
