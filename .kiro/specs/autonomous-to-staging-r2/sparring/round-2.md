# Sparring round 2 — in_progress

Session: `87068fbf-b3ce-4623-94c3-a8e18b3e28fd` · plan hash `9af487bc0524071558bac7f447f9b9689abe80c6d707246c513de7f3d86f234b`

## Summary

All five R1 findings were accepted and the revised plan addresses them substantively. I verified the key premises and found three new issues in the revision: (1) logSection/logEntries in queue.mjs are not exported, so land-guard.mjs cannot import them as the plan assumes; (2) the governance.ts protectedReviewOnCurrentHead plan to use review_only_since while "excluding merge commits" is underspecified — the observer-computed list doesn't carry that information; (3) the plan says ReviewEntry gains `session` but the type already has `session_id`.

## Findings

### R2-F1 [minor]

The plan §3.1.2 says the self-review exclusion reads builder sessions 'with the existing `logSection` helper of `queue.mjs`', implying land-guard.mjs imports it. But `logSection` (line 296) and `logEntries` (line 302) are plain (non-exported) functions in queue.mjs. land-guard.mjs cannot import them without first exporting them. Since queue.mjs is a protected gate file, this export change should be noted in the plan.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:296` — function logSection(text) {
    const t = String(text || '').replace(/\r\n/g, '\n');
    const i = t.search(/^## Log[ \t]*$/m);
    return i < 0 ? '' : t.slice(i);
  }

  /** Log entries `{ time, session, change, body }` in file order; text before the first `### ` is ignored. */
  function logEntries(log) {
- `exafyltd/vitana-platform:scripts/collab/land-guard.mjs:29` — import { globToRegex, PROTECTED_GATE_PATHS, GOVERNANCE_PATHS, REVIEWER_AGENTS } from './queue.mjs';

Suggestion: Note in the plan that `logSection` and `logEntries` (or a combined helper) must be exported from queue.mjs for land-guard.mjs to use them. This is already within the lane's declared path changes to queue.mjs but should be explicit since it widens the exported API surface of a protected file.

### R2-F2 [major]

The plan §3.1.2 says governance.ts `protectedReviewOnCurrentHead(r, pr)` will use `pr.review_only_since` but exclude merge commits. However, `review_only_since` is computed by the observer and is a flat list of SHAs (heads after which only lane-file-only commits followed). The current `reviewOnCurrentHead` (governance.ts:167-170) trusts this list directly: `(pr.review_only_since ?? []).includes(r.head_sha)`. If the observer currently includes SHAs followed by merge commits in `review_only_since` (because normal `reviewOnCurrentHead` allows merges when `prDiffSame === true`), then `protectedReviewOnCurrentHead` cannot simply filter this list — it lacks the information about whether merge commits intervened. The plan does not specify whether (a) the observer is changed to compute a separate `protected_review_only_since` that excludes merge commits, (b) the governance decide-time does a separate walk, or (c) the strict rule (exact head only) is used for protected-file accepts in governance.ts.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:162` — /**
   * Is the review on the PR's current head? Exact head, or an earlier head after
   * which every commit only appended review entries / PM lane-state lines to this
   * lane's file (`review_only_since`, computed by the observer).
   */
  export function reviewOnCurrentHead(r: ReviewEntry, pr: ObservedPr): boolean {
    if (r.head_sha === pr.head_sha) return true;
    return (pr.review_only_since ?? []).includes(r.head_sha);
  }
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:67` — export function protectedAcceptModels(reviews: readonly ReviewEntry[], pr: ObservedPr | null): string[] {
    if (!pr) return [];
    const models = new Set<string>();
    for (const r of reviews) {
      if (!isAgentReview(r) || !reviewOnCurrentHead(r, pr)) continue;
      const m = /\(([^)]+)\)\s*$/.exec(String(r.reviewer ?? '').trim());
      if (m && REVIEWER_AGENT_MODELS.includes(m[1])) models.add(m[1]);
    }
    return [...models];
  }

Suggestion: Specify the mechanism: either (a) use exact-head-only (`r.head_sha === pr.head_sha`) for protected-file accepts in governance.ts — the simplest strict rule, consistent with the land-guard protectedReviewCurrent rejecting merges; or (b) add a new observer-computed field `protected_review_only_since` that excludes heads followed by merge commits. Option (a) is recommended for simplicity and strictness parity between the two layers.

### R2-F3 [minor]

The plan §3.1.2 says 'governance.ts: `ReviewEntry` gains `session`'. But the `ReviewEntry` type in types.ts already has `session_id: string` (line 60). Adding a separate `session` field would create a confusing duplicate. The plan should reference the existing `session_id` field for builder-exclusion and distinct-session checks.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/types.ts:57` — /** A review entry parsed from a lane log (carries a `Collab-Review` trailer). */
  export interface ReviewEntry {
    /** The reviewer's session id (from the `Collab-Session` on the review commit). */
    session_id: string;
    /** The seat that authored the review (from `reviewer_seat`/the review trailer). */
    reviewer_seat: string;
    verdict: ReviewVerdict;
    /** The PR head sha this review was made against. */
    head_sha: string;
    /** ISO timestamp of the review. */
    at: string;
    /**
     * VTID-05274: the `Collab-Reviewer` value, e.g.
     * `agent:vitana-lane-reviewer (claude-sonnet-5.5)`; null/absent for a legacy seat review.
     */
    reviewer?: string | null;
  }

Suggestion: Correct the plan: governance.ts should use the existing `ReviewEntry.session_id` field for the distinct-session and builder-exclusion checks, not add a new `session` field. Also note in the shared fixture cases that the governance test uses `session_id` while land-guard's `parseReviewEntry` returns `session` — the fixture must map between the two names.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
