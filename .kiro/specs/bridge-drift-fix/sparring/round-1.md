# Sparring round 1 — in_progress

Session: `e0becf56-5b74-431e-8481-62458e34a9a1` · plan hash `8d4552c7ba4cd80e0b75ac9899da444a01c10beb296564f46ce4b5cc8495908e`

## Summary

The plan's four independent fixes are well-scoped, correctly diagnosed, and verifiable. All key premises I checked hold against the pinned commit. No blockers or major issues found. One minor observation about future brittleness in C3.

## Findings

### R1-F1 [minor]

C3 widens the regex from `owner approval` to `(?:owner|machine) approval`, which still pins a specific middle-clause word. The test's own comment (line 35-36) says 'Pin the stable endpoints of the flow rather than the exact middle clause so a future wording tweak does not re-break it.' A more durable fix aligned with that comment would match any word before 'approval' (e.g. `\w+ approval`) rather than enumerating known words. This is not a correctness issue — the fix is correct for today's text — but it will break again if the wording changes to e.g. 'policy approval' or 'automated approval'.

- `exafyltd/vitana-platform:services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts:33` — // VTID-05214 reworded rule 51 to include the CI-sparred policy-approval path
// ... Pin the stable endpoints of the
// flow rather than the exact middle clause so a future wording tweak does not re-break it.
expect(md).toMatch(/[Pp]lan → sparring → owner approval[\s\S]*?→ VTID → code\./);
- `exafyltd/vitana-platform:CLAUDE.md:336` — 51. **Back-end and complex work: plan → sparring → machine approval on convergence (local partner or CI policy
    approval `converged-auto-v1`, VTID-05214) → VTID → code.**

Suggestion: Consider widening the regex to something like `/[Pp]lan → sparring → \S+ approval[\s\S]*?→ VTID → code\./` so the stable endpoints (plan → sparring → …approval… → VTID → code) are tested without enumerating approval-type words. This better matches the test's own stated intent.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
