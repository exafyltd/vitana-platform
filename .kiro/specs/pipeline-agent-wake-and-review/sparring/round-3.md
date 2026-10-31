# Sparring round 3 — escalated

Session: `6b6afa7f-87ba-457a-bb13-548332559c6e` · plan hash `7527976c5f1910a6683c4984a2d02c04ab738e1eb933b4f7137d9bae64b858a6`

## Summary

Round 3 review. Both R2-F1 and R2-F2 were accepted and addressed in the revised plan. Three new findings raised: one about guard.cjs missing from the lane scope, one about `isAgentReview`'s signature being unable to enforce the plan's three conditions, and one about the new `Collab-Fallback-Reason` trailer needing type and observer support.

## Findings

### R3-F1 [major]

Lane 2 item 2 says 'guard.cjs pins that equality (tools, permissions, fail-loudly rules) and that the model is in REVIEWER_AGENT_INDEPENDENT_MODELS or the list is empty', but guard.cjs is not listed in any lane's file paths. Currently `checkAgents` (guard.cjs:145-175) only validates the single `REVIEWER` constant (`.kiro/agents/vitana-lane-reviewer.md`) — there is no code to validate the independent agent file. New validation code must be added to guard.cjs, but this file (under `scripts/ci/kiro-steering/`) is not in lane 2's scope and is not mentioned anywhere in the plan's file lists.

- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:99` — const REVIEWER = '.kiro/agents/vitana-lane-reviewer.md';
- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:145` — function checkAgents(root) {
    const errors = [];
    ...
    const agent = readText(root, REVIEWER);
    if (agent === null) {
      errors.push(`${REVIEWER} missing`);
    } else {
      const fm = parseFrontMatter(frontMatter(agent));
      if (fm.name !== 'vitana-lane-reviewer') errors.push(`${REVIEWER}: name must be vitana-lane-reviewer`);
      ...
      for (const s of REQUIRED_BODY) if (!agent.includes(s)) errors.push(`${REVIEWER}: prompt is missing ${s}`);
    }

Suggestion: Add `scripts/ci/kiro-steering/guard.cjs` to lane 2's file paths. Inside `checkAgents`, add a block that reads `.kiro/agents/vitana-lane-reviewer-independent.md` (when it exists), validates its tools/excludedTools/permissions/includeMcpJson/includePowers match the chain reviewer's, and checks that its `model:` is in `REVIEWER_AGENT_INDEPENDENT_MODELS` (or that the list is empty and no model is pinned). Also add `guard.cjs` to the hot-file note since `pipeline-lane-state-efficiency` may also touch it.

### R3-F2 [major]

The plan says '`isAgentReview` accepts [the independent reviewer] only when (a) the model is in that list, (b) the review entry records that every chain model was tried … and (c) the lane PR changes no governance path'. But `isAgentReview` (governance.ts:133-135) takes only a `ReviewEntry` parameter — it has no access to the lane's paths or PR files. Condition (c) cannot be enforced inside `isAgentReview`. The callers `reviewSatisfiesLane` (line 162) and `governanceMergeAllowed` (line 196) do have the `lane` and `pr` parameters needed, but the plan doesn't describe where condition (c) is actually checked. If the independent reviewer identity is simply added to `AGENT_REVIEWER_VALUES`, `isAgentReview` would return true for governance lanes too, and `reviewSatisfiesLane` would accept it unconditionally at line 162.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:132` — /** An `accept` written for the reviewer agent (exact identity; `agent:someone-else`, `…-fake`, null never count). */
export function isAgentReview(r: ReviewEntry): boolean {
  return r.verdict === 'accept' && typeof r.reviewer === 'string' && AGENT_REVIEWER_VALUES.has(r.reviewer.trim());
}
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:159` — export function reviewSatisfiesLane(lane: ObservedLane, r: ReviewEntry): boolean {
  const pr = lane.pr;
  if (!pr) return false;
  if (isAgentReview(r)) return reviewOnCurrentHead(r, pr);
  if (r.reviewer) return false;
  ...
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:196` —   if (isAgentReview(review)) {
    return pr != null && reviewOnCurrentHead(review, pr) ? { ok: true } : { ok: false, reason: 'stale_head' };
  }

Suggestion: Specify the enforcement architecture. Option A: keep `isAgentReview` for the chain reviewer only; add a separate `isAgentIndependentReview(r: ReviewEntry): boolean` that checks conditions (a) and (b); then in `reviewSatisfiesLane` and `governanceMergeAllowed`, call `isAgentIndependentReview` only after verifying the lane doesn't touch governance (condition c). Option B: add a new compound function `isAcceptableReview(r: ReviewEntry, lane: ObservedLane)` that enforces all three conditions together. Either way, spell out which function enforces which condition at which call site, and add test cases for each.

### R3-F3 [minor]

`Collab-Fallback-Reason: chain_unavailable` is a new trailer (zero codebase hits). The plan's condition (b) requires the review entry to record that every chain model was tried, but `ReviewEntry` (types.ts:58-73) has no field for fallback reason. The plan doesn't mention: extending the `ReviewEntry` interface, how the observer parses this new trailer, or how the governance check reads it. Without this, condition (b) is unimplementable in the typed governance layer.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/types.ts:57` — /** A review entry parsed from a lane log (carries a `Collab-Review` trailer). */
export interface ReviewEntry {
  session_id: string;
  reviewer_seat: string;
  verdict: ReviewVerdict;
  head_sha: string;
  at: string;
  reviewer?: string | null;
}

Suggestion: Add to the plan: (1) extend `ReviewEntry` with an optional `fallback_reason?: string` field; (2) describe how the observer parses the `Collab-Fallback-Reason` trailer into this field; (3) add a test that a review entry with `reviewer: agent:vitana-lane-reviewer-independent (gpt-5.6-terra)` but no `fallback_reason: chain_unavailable` is rejected by the governance check.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Properly addressed. Lane 2 item 3a now covers REVIEWER_AGENTS expansion, scopeCheck acceptance of independent sessions on chain-reviewer lanes, validateLane refusal of direct independent reviewer_seat, and three corresponding test cases.
- R2-F2: acknowledged — Properly addressed. The push trigger is narrowed to `branches: ['kiro/**']` AND `paths: ['.kiro/specs/*/lanes/*.md']`, filtering out non-lane-file pushes. decide() still re-checks the Collab-Verdict trailer as a defence in depth.
