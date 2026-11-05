# Sparring round 1 — in_progress

Session: `4260150e-27e0-4ea1-a5ff-a6ae38317ecb` · plan hash `1359a262bc4fb99d79a2f62c49af20a4ce263c2b6cedd98f32185eef62cbbef7`

## Summary

The plan is well-structured and the key premises about the bridge code, legacy read path, shadow infrastructure, flag pins, and protected gate files all hold against the pinned commit. The caller-site analysis in orb-live.ts is accurate — all six call sites handle `ok:false` or empty items gracefully. One minor gap found regarding an unlisted test file that references the recall flag.

## Findings

### R1-F1 [minor]

`services/gateway/test/vtid-04452-staging-orb-recall-pinned.test.ts` is not mentioned anywhere in the plan (not listed as changed, unchanged, or removed) and is not covered by the lane's path globs (`services/gateway/test/services/memory/**` does not match `services/gateway/test/vtid-04452-*`). Search shows this file references `isOrbRecallEnabled`. If it asserts bridge-level behaviour that depends on the recall flag gating (e.g. that the bridge falls back to legacy when the flag is off), it will break after the legacy read is deleted, and the lane cannot touch it because the path is outside its declared scope.

- `exafyltd/vitana-platform:services/gateway/test/services/memory/recall-bridge-wiring.test.ts:4` — jest.mock('../../../src/services/memory/recall', () => ({
  isOrbRecallEnabled: () => process.env.MEMORY_ORB_RECALL_ENABLED === 'true',
  recallOrbMemoryItems: (...a: any[]) => mockRecall(...a),
}));
- `exafyltd/vitana-platform:services/gateway/test/services/memory/recall-bridge-wiring.test.ts:28` — it('flag off: recall is never called', async () => {
  delete process.env.MEMORY_ORB_RECALL_ENABLED;
  const r = await fetchMemoryContextWithIdentity(ID);
  expect(mockRecall).not.toHaveBeenCalled();
  expect(r.error).toBe('Supabase not configured');
});

Suggestion: Read `test/vtid-04452-staging-orb-recall-pinned.test.ts` to determine whether it tests the bridge's use of the flag (would break) or only the deploy-workflow pin value (safe). If it tests bridge behaviour, add its path to the lane's paths list and update or remove it. If it only tests the pin, note it as unchanged in the plan.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
