# Sparring round 1 — in_progress

Session: `d42e6d11-da3b-4667-a583-5fa34778196f` · plan hash `e5a008d384738430aa4821fdac1cf1e626488b3a0b0e03f2048409176c0a0168`

## Summary

The plan is well-structured and the core design (append-only log, per-edge validation via existing `checkTransition`, evidence requirements for each edge type) is sound. Authorization is correctly preserved because per-commit trailer checks (§2.3) are independent of transition validation. Most premises hold. I found one major gap (intermediate `parked` state handling) and two minor issues (a misleading example citation and a missing test scenario).

## Findings

### R1-F1 [major]

`parked_from` is not tracked dynamically for intermediate `parked` states in a chain. The plan says each edge is checked with `checkTransition` using 'the base `parked_from` for a `parked →` edge', meaning the merge-base front-matter's `parked_from`. But if the chain enters and leaves `parked` as an intermediate state (e.g. `executing → parked → executing → in-review`), the merge-base state is `executing` and has no `parked_from`. `checkTransition` at line 256 checks `b === before.parked_from`; with `before = {state: 'parked', parked_from: undefined}` the `parked → executing` edge would always fail. The chain function must synthesize `parked_from` from the preceding `→ parked` edge (the origin state of that edge), or explicitly exclude intermediate parking and document why.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:246` — if (a === 'parked') return b === before.parked_from ? [] : [`a parked ${kind} may only return to "${before.parked_from}" (got "${b}")`];
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:47` — const LANE_EDGES = {
  ready: ['executing'],
  executing: ['in-review'],
  'in-review': ['verified', 'executing'],
  verified: ['done'],
  done: [],
};

Suggestion: In `transitionChain`, when an edge `X → parked` is processed, record `parked_from = X`. When the next `parked → Y` edge is checked, pass `{state: 'parked', parked_from}` to `checkTransition`. Add a test: valid chain `executing → parked → executing → in-review` (with appropriate entries); invalid chain `executing → parked → in-review` (parked_from is executing, not in-review). Alternatively, if intermediate parking in a single PR is intentionally unsupported, state that explicitly and add a test that it rejects with a clear message.

### R1-F2 [minor]

§2.4 cites `web-steering.md:57` as the example of a closing record carrying `merge: <sha>`, and §3.1 places the `merge:` evidence requirement on the `verified → done` edge. However, line 57 is actually the body of the `in-review → verified` entry (line 56 heading). The `verified → done` entry (line 59-60) uses `Merge \`...\`` (capitalised, backtick-wrapped, no colon). This means the cited example contradicts the proposed rule: real closing records put `merge:` on `in-review → verified`, not `verified → done`. If the evidence rule stays on `verified → done`, the documentation example should be corrected and the writing convention aligned so chain authors know where to place `merge:`.

- `exafyltd/vitana-platform:.kiro/specs/kiro-web-steering/lanes/web-steering.md:56` — ### 2026-10-26T15:59Z · kiro-exafyltd-202610261510-099d · in-review → verified
Review entry `Collab-Verdict: accept` from agent:vitana-lane-reviewer ... merge: b117ce6216c9555169feff28e96b03cf4e64b02b ...

### 2026-10-26T16:03Z · kiro-exafyltd-202610261510-099d · verified → done
Lane closed under §7b. Merge `b117ce6216c9555169feff28e96b03cf4e64b02b` (#4379).

Suggestion: Either (a) move the `merge:` evidence requirement to `in-review → verified` (matching today's convention), or (b) keep it on `verified → done` but update the plan's §2.4 citation and ensure the collaboration.md convention is updated so authors know to put `merge: <sha>` in the `verified → done` entry body when writing chains.

### R1-F3 [minor]

The test matrix in §3.5 does not include a valid chain that passes through an intermediate `parked` state (e.g. `executing → parked → executing → in-review`), nor an invalid one where the parked return target differs from the parked_from. Whether R1-F1 is resolved by dynamic tracking or by explicit exclusion, a test is needed to prove the chosen behaviour.

- `exafyltd/vitana-platform:scripts/collab/queue.test.mjs:61` — test('checkTransition: plan and lane tables, done terminal, parked returns only where it came from', () => {
  ...
  assert.deepEqual(checkTransition('plan', p('parked', { parked_from: 'executing' }), p('executing')), []);
  assert.equal(checkTransition('plan', p('parked', { parked_from: 'executing' }), p('approved')).length, 1);
  ...

Suggestion: Add to the test plan: (1) valid chain `executing → parked → executing → in-review` with correct entries and timestamps; (2) invalid chain `executing → parked → in-review` where the parked return goes to the wrong state.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
