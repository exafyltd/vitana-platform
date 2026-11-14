---
change_class: standard
---
# Plan — collab-lane-close-exception

Author: Claude Code session `session_01Cp885FfhfWqu4KXDE5NRMh` (owner-directed, handover of the profile-posts and
staging-verify-runner-fix specs). Code repo: `exafyltd/vitana-platform` (scripts and rules only; no runtime code, no
migration, no deploy).

<!-- plan:begin -->
## Goal
Two lanes were merged and verified green on staging but cannot reach `done` in the collab ledger: the reviewer agent
(`agent:vitana-lane-reviewer`) never ran for them, and `scripts/collab/queue.mjs` requires an accept review entry
before `in-review → verified`. The owner chose a narrow, written exception instead of a fabricated review.

## Measured state (origin/main)
- `scripts/collab/queue.mjs` `LANE_EDGES`: `in-review → verified` only; `verified → done` only.
- `in-review → verified` requires a latest `accept` review entry with a Collab-Review commit (around line 380).
- `verified → done` requires a merge SHA (around line 385).
- `parked` returns only to `parked_from` (line 271).
- The two specs `profile-posts-full-width` (lanes `card-layout`, PRs vitana-v1 #1489) and
  `staging-verify-runner-fix` (lanes `runner` = vitana-platform #4311, `manifests` = vitana-v1 #1491) are the only
  lanes this exception covers. Their PRs are merged (verified via GitHub, 2026-11-11).

## Change
1. `queue.mjs`: `transitionChain` takes the spec slug in its options (`{ reviewCommits, laneStates, slug }`), passed
   from `validateRange` as `c.slug` (R1-F2). A lane's `in-review → verified` edge is also accepted when the lane file's front matter carries
   flat top-level fields `reviewer_exception: true`, `reviewer_exception_approval` (the owner's decision reference and
   date), `reviewer_exception_pr` and `reviewer_exception_merge_sha` (R2-F1: `parseFrontMatter` reads top-level scalars
   only, so no nested object), AND the
   lane's spec slug is in the explicit allowlist `CLOSED_BY_OWNER_EXCEPTION = ['profile-posts-full-width',
   'staging-verify-runner-fix']` in the same file. Any other lane still needs the reviewer accept.
2. The `verified → done` merge-SHA check is unchanged: the exception still needs a merge SHA.
3. `.claude/rules/collaboration.md` §3 gets one paragraph naming the exception, its allowlist and that it does not
   extend to new lanes.
4. Tests in `queue.test.mjs`: (a) exception accepted for an allowlisted slug, (b) same record rejected for a
   non-allowlisted slug, (c) normal reviewer accept path unchanged, (d) missing merge SHA still rejected.
5. Then the lane files and handoffs are moved with the exception record, in a separate PR after this plan converges.
   Chains per file at the pinned commit (R1-F1):
   - `profile-posts-full-width/lanes/card-layout` (parked, parked_from in-review): `parked → in-review → verified → done`.
   - `staging-verify-runner-fix/lanes/runner` (parked, parked_from executing): `parked → executing → in-review → verified → done`.
   - `staging-verify-runner-fix/lanes/manifests` (ready): `ready → executing → in-review → verified → done`.
   - both handoffs (approved): `approved → executing → in-review → verified → done`.
   Each `executing → in-review` entry carries its PR URL (queue.mjs around line 372); `verified → done` carries the merge SHA.

## Tests
`node --test scripts/collab/queue.test.mjs` (existing tests plus the four new cases above). No staging or production
test; this changes only repository scripts and records.

## Risks
- An exception that spreads: mitigated by the explicit allowlist in code, not in a config value.
- It changes a governance gate: this plan goes through sparring and owner approval before any change to `queue.mjs`.
- `queue.mjs` is a protected gate file (`PROTECTED_GATE_BUILTIN`, collaboration §3a). The implementation PR merges
  only after the owner's instruction naming this plan AND a reviewer-agent accept on the final head. The exception in
  this plan does not waive that rule for the implementation itself (R1-F3).

## Unchanged
Reviewer-accept rule for every other lane; merge rules (§7b); production publish rules (§7c); the plan-sparring gate.
<!-- plan:end -->
