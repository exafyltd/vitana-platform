# Sparring round 1 — in_progress

Session: `00fb23df-922c-4a87-91d7-c3c1abb0e217` · plan hash `add16811578454bf6863225e0c16d33983b882c835f0c446a1275541db44a3b3`

## Summary

The plan's premises are accurate. The shell permission rules, `sessionId()`/`agentOf()` functions, scope-check validator, protected-gate-files list, and agent instruction text all match the plan's descriptions at the cited lines. The architectural approach—adding the narrowest pattern to both the allow `match:` and deny `exclude:`, with empirical validation—is sound. One major finding about a likely agent self-contradiction in the Hard limits text, and one minor finding about test case redundancy.

## Findings

### R1-F1 [major]

The agent's Hard limits section (lines 47-49) contains an exhaustive enumeration of allowed shell commands: 'Your tools allow reading files and only these shell commands: git -C <repo> diff|log|show|fetch origin|merge-base|rev-parse, gh pr view, gh pr checks, gh run view.' The plan's lane step 2 says 'Updates the agent's instructions so it runs the command at the start of a review' but does not explicitly require updating the Hard limits enumeration. If the implementer adds a run-the-command instruction elsewhere in the file without also expanding the Hard limits list, the agent will see self-contradictory instructions ('only these shell commands' vs. 'run this other command') and may refuse to execute the session-id command, defeating the plan's purpose.

- `exafyltd/vitana-platform:.kiro/agents/vitana-lane-reviewer.md:46` — ## Hard limits
- Read-only. Never edit, write, delete, commit, push, merge, approve or comment on GitHub, re-run or dispatch a
  workflow, allocate a VTID, or deploy. Your tools allow reading files and only these shell commands: `git -C <repo>
  diff|log|show|fetch origin|merge-base|rev-parse`, `gh pr view`, `gh pr checks`, `gh run view`. Never chain commands.

Suggestion: Explicitly state in lane step 2 that the Hard limits enumeration at line 48-49 must be expanded to include the `queue.mjs session-id` command, keeping it consistent with the new permission rule. For example: '…and `node …/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer`'.

### R1-F2 [minor]

The plan's Tests section describes adding cases for `sessionId('agent:vitana-lane-reviewer')` format, `agentOf()` mapping, scope-check acceptance of an agent review entry, and rejection of a non-agent id—but tests T8 (lines 994-1007) and T7 (lines 976-991) already cover almost all of these. The only genuinely new case described is the `--seat` refusal (`sessionId(AG, date, 'someseat')` throwing). The plan should acknowledge existing coverage and specify precisely which new cases it adds, both so the reviewer can verify red→green and so the implementer does not duplicate existing assertions.

- `exafyltd/vitana-platform:scripts/collab/queue.test.mjs:994` — test('VTID-05276 T8: agent session ids — format, agentOf, session-id for a listed agent only', () => {
  assert.ok(isSessionId(AGS));
  assert.equal(Q.agentOf(AGS), AG);
  assert.equal(Q.agentOf(JT), '');
  assert.equal(seatOf(AGS), '');
  assert.ok(Q.isReviewerAgent(AG));
  assert.ok(!Q.isReviewerAgent('agent:other'));
  const id = sessionId(AG, new Date(Date.UTC(2026, 9, 20, 17, 0)));
  assert.match(id, /^agent-vitana-lane-reviewer-202610201700-[0-9a-f]{4}$/);
  assert.ok(isSessionId(id));
  assert.throws(() => sessionId('agent:other'));
  assert.throws(() => sessionId('claude'));
  for (const bad of ['agent-202610201700-ab12', 'agent-X-202610201700-ab12', 'agent-vitana-lane-reviewer-2026102017-ab12']) assert.ok(!isSessionId(bad), bad);
});
- `exafyltd/vitana-platform:scripts/collab/queue.test.mjs:976` — test('VTID-05276 T7: an agent review entry passes scope-check and validate; the same entry from a Kiro seat fails', () => {
  ...
  assert.deepEqual(scopeCheck(f.work, { base, head, branch: 'kiro/cards/card-01' }).errors, []);
  assert.deepEqual(validateRange(f.work, { base, head }).errors, []);
  ...
  const e = scopeCheck(f.work, { base, head: h2, branch: 'kiro/review-seat' }).errors;
  assert.ok(e.some((x) => x.includes(`reviewer_seat is ${AG}`)), e.join('\n'));
});

Suggestion: List the genuinely new test case(s) (e.g., `sessionId(AG, date, 'someseat')` throws 'a reviewer agent id names no seat') and note that existing T7/T8 already cover format, agentOf, and scope-check acceptance. This makes the red→green evidence clearer and avoids duplicate assertions.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
