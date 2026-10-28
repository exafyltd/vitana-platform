# Sparring round 2 — in_progress

Session: `6b6afa7f-87ba-457a-bb13-548332559c6e` · plan hash `eca8328e16308b0acbe53e88b1fdb6d81db7c8e4ea59f5fffa266c49dcf4bd19`

## Summary

The revised plan properly addressed all four R1 findings. GOVERNANCE_PATHS condition (c) now uses the existing definition, the bare independent identity is excluded, SLUG_RE is handled via local copy with parity test, and the line reference is corrected. One new major finding: the independent reviewer's session identity will fail the Lane Scope check in queue.mjs because `agentOf()` returns a different agent name than the lane's `reviewer_seat`. One minor finding about workflow trigger breadth.

## Findings

### R2-F1 [major]

Lane 2 introduces an independent reviewer agent (`agent:vitana-lane-reviewer-independent`) with its own session id format (`agent-vitana-lane-reviewer-independent-YYYYMMDDHHMM-xxxx`), but the Lane Scope check in `queue.mjs` scopeCheck (line 709-713) validates that a review entry's session matches the lane's `reviewer_seat`. When the independent reviewer posts a review entry, `agentOf(session)` returns `agent:vitana-lane-reviewer-independent`, which does NOT equal the lane's `reviewer_seat` of `agent:vitana-lane-reviewer`. The scope check would reject every independent review entry with an error like 'review entry on <key> from <session>, but reviewer_seat is agent:vitana-lane-reviewer'. This makes the independent reviewer fallback fail CI on every lane it reviews.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:709` — if (k.review === key && k.lane !== key) {
        const ok = fm.reviewer_seat === 'claude' ? /^session_/.test(k.session)
          : isReviewerAgent(fm.reviewer_seat) ? agentOf(k.session) === fm.reviewer_seat
            : !fm.reviewer_seat || seat === fm.reviewer_seat;
        if (!ok) errors.push(`${short}: review entry on ${key} from ${k.session || 'no session'}, but reviewer_seat is ${fm.reviewer_seat}`);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:74` — export const REVIEWER_AGENTS = ['agent:vitana-lane-reviewer'];
export const isReviewerAgent = (v) => REVIEWER_AGENTS.includes(v);
/** The reviewer agent named in an agent session id (`agent:<name>`), else ''. */
export const agentOf = (s) => {
  const m = /^agent-([a-z][a-z0-9-]{0,40})-\d{12}-[0-9a-f]{4}$/.exec(s || '');
  return m ? `agent:${m[1]}` : '';
};

Suggestion: Lane 2 already edits queue.mjs. Extend the scope check at line 711 to also accept the independent reviewer's session on lanes whose `reviewer_seat` is the chain reviewer — e.g. `agentOf(k.session) === fm.reviewer_seat || (fm.reviewer_seat === REVIEWER_AGENTS[0] && agentOf(k.session) === 'agent:vitana-lane-reviewer-independent')`. Add a corresponding test case: independent reviewer session posting a review entry on a lane with `reviewer_seat: agent:vitana-lane-reviewer` → no error. Also consider adding `agent:vitana-lane-reviewer-independent` to REVIEWER_AGENTS so `isReviewerAgent` recognises it.

### R2-F2 [minor]

DRIVER-WAKE.yml triggers on `push: kiro/**` (all Kiro branch pushes). Every lane commit pushes to `kiro/<slug>/<lane>`, so the workflow fires on every lane push across the entire repo — potentially dozens per hour — even though only the rare push carrying a `Collab-Verdict:` trailer is actionable. The `decide()` function quickly skips non-verdict pushes, but each no-op run still consumes a workflow slot and adds noise to the Actions tab.

- `exafyltd/vitana-platform:.kiro/pipeline/driver.md:55` — 4. **Review an `in-review` lane** with the reviewer agent `vitana-lane-reviewer` (model chain `claude-sonnet-5.5` →
   `claude-opus-5.5` → `claude-sonnet-4.5`), run as its own agent session on the PR's current head. Write its §4.2 verdict
   as the §4.1 review entry (trailers `Collab-Session`, `Collab-Review: <slug>/<lane>`, `Collab-Verdict`,
   `Collab-Reviewer: agent:vitana-lane-reviewer (<model it ran on>)`, `Collab-Reviewed-Head`).
- `exafyltd/vitana-platform:.claude/rules/collaboration.md:89` — - **Review entry** (the reviewer agent's verdict, committed by the calling session): one commit that appends one
    entry to `.kiro/specs/<slug>/lanes/<lane-id>.md`, front matter unchanged, trailers:
    ```
    Collab-Session: <reviewer session>
    Collab-Review: <slug>/<lane-id>
    Collab-Verdict: accept | changes
    Collab-Reviewer: agent:vitana-lane-reviewer (<model>)
    Collab-Reviewed-Head: <40-hex PR head the agent reviewed>
    ```

Suggestion: Document the expected no-op run volume as an accepted cost. If it matters, consider filtering: the review entry commit always changes a file under `.kiro/specs/*/lanes/*.md`, so a paths filter could narrow the trigger (e.g. `paths: ['.kiro/specs/*/lanes/*.md']` combined with `branches: ['kiro/**']`). Alternatively, fire DRIVER-WAKE only from the PLAN-SPAR `workflow_run` trigger and a dedicated `repository_dispatch` event the driver emits after writing a verdict, instead of a blanket `push`.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Properly fixed. Condition (c) now uses the existing GOVERNANCE_PATHS definition, and the plan explicitly notes .kiro/specs/** files are not governance paths.
- R1-F2: acknowledged — Properly fixed. The plan now correctly states the bare chain identity is accepted, and the bare independent identity is explicitly excluded with a test case.
- R1-F3: acknowledged — Properly addressed. driver-wake.mjs keeps its own copy with a parity test reading all three sources.
- R1-F4: acknowledged — Corrected to guard.cjs:123.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
