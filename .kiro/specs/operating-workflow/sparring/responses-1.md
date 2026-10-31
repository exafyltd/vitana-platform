# Responses to sparring round 1

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "The authority file must not be weaker than the files it supersedes. Plan changes: (1) review-independence adds `.claude/rules/operating-policy.md` and `.kiro/steering/vitana-operating-policy.md` to scripts/collab/protected-gate-files.json and to both compiled-in copies (queue.mjs loadProtectedGatePaths fallback, governance.ts PROTECTED_GATE_GLOBS) with the parity test. vitana-v1's PR-GATE fetches queue.mjs (and so the list) from vitana-platform main (vitana-v1/.github/workflows/PR-GATE.yml:81-91), so the same relative globs protect the v1 copies. (2) Because the list update lands after the policy is first written, policy-text and policy-text-v1 keep executor: kiro (their lane files are unchanged in this round) but their acceptance and the plan's merge precondition require the §3a review (Claude review on the current head or an owner instruction naming operating-workflow) even before the list is updated, so the authority's first content is owner-reviewed too. One owner instruction naming this plan covers every protected lane of it (plan §4, §9).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "land-guard.mjs becomes the merge-time caller of review-rule.mjs, so it joins the protected list in review-independence (plan §5 and §9 updated; it is already in that lane's paths).",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Correct: on a pm-agent bookkeeping PR the Lane scope PERM rule (queue.mjs:678-684; sessions excludes PM_AGENT, so claudeOnly is false) rejects any change of seat/executor/reviewer_seat/paths before the equality check at :227. Plan §2.4 now names the PERM rule as the effective rejection. pm-noop follows from it: the PM never writes a permission key. applyLaneChange throws on any change of seat, executor, reviewer_seat or paths (not only seat == reviewer_seat); decide.ts stale_ready produces no decision when the target would change `seat` (only the `claude` target, which keeps the seat, remains), so the stale lane stays visible on the queue instead of producing a write CI rejects. Tests: reassign-seat.test.ts covers the PERM refusal and a scope-check fixture (queue.mjs scope-check over a pm-agent commit changing seat → error) recorded as evidence of the rejection path. The PM stays paused; re-enabling it is an owner decision.",
    "deferred_to": ""
  }
]
```
