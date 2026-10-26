# Sparring round 1 — in_progress

Session: `5a0cf985-3b6b-481e-971b-dfa3280e35fb` · plan hash `82e62c5a580b0f73149f20329f777b28c91a8fa7802bb32796b673e5014b578c`

## Summary

The plan is well-researched and most premises hold against the pinned code. The core approach—a generator script that rewrites repo-relative `#[[file:]]` paths and `fileMatchPattern` globs into workspace-relative equivalents, plus an extra driver steering file—is sound and correctly addresses the observed problem. I found one major gap (missing lane governance configuration) and two minor issues.

## Findings

### R1-F1 [major]

The plan declares "one lane `web-steering`" (Section 3 heading) but never specifies the lane's `executor` or `reviewer_seat`. The lane creates `scripts/collab/kiro-web-steering.mjs` and `scripts/collab/kiro-web-steering.test.mjs`, both under `scripts/collab/**` which is a governance path (queue.mjs:85). Per queue.mjs:231-234, an `executor: kiro` lane that touches a governance path must have `reviewer_seat: agent:vitana-lane-reviewer`, and an `executor: kiro` lane can never touch a protected gate file. Section 2 notes the constraint as a premise observation but Section 3 does not carry it forward as a lane requirement. An implementer who misses this will hit a CI-time governance rejection from `queue.mjs validate` or the Lane-scope check.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:82` — export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**',
  'CLAUDE.md', 'docs/programs/areas.yaml'];
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:231` — if (fm.executor === 'kiro') {
      for (const g of paths) {
        if (globTouchesProtected(g)) e.push(`paths "${g}" reaches a protected gate file ...`);
        else if (globTouchesGovernance(g) && !isReviewerAgent(fm.reviewer_seat)) e.push(`paths "${g}" reaches a governance path; such a lane needs executor: claude, or reviewer_seat: ${REVIEWER_AGENTS[0]}`);
      }

Suggestion: Add to Section 3 (or a new "Lane file" subsection): the lane must declare `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`, and `paths` that include `scripts/collab/kiro-web-steering.mjs`, `scripts/collab/kiro-web-steering.test.mjs`, `AGENTS.md`, and `docs/kiro/**`. Confirm none of those paths match a protected-gate-file glob.

### R1-F2 [minor]

The AGENTS.md addition (Section 3B) is gated on a file-existence check (`<workspace>/.kiro/steering/vitana-platform--vitana-pipeline.md` missing). In a Codex sandbox, the workspace layout differs and this file will always be absent, so a Codex agent reading AGENTS.md could interpret the instruction as applicable and attempt to run the generator script, wasting time or erroring. The plan says the new section is titled "Kiro Web: load the Vitana steering", but AGENTS.md is consumed by multiple agent runtimes (Codex, Kiro Web, potentially others) and the existing content has no runtime-specific gating.

- `exafyltd/vitana-platform:AGENTS.md:1` — # Repository Scope

Strict rule: Codex may only work with these GitHub repositories:

- `exafyltd/vitana-v1`
- `exafyltd/vitana-platform`

Codex must ignore every other GitHub repository. ...

Suggestion: Add an explicit guard to the AGENTS.md section: e.g. "This section applies only in Kiro Web sessions (when the workspace root is above the repo checkouts and `.kiro/steering/` is the workspace-level steering directory). Codex and Claude Code sessions must ignore it."

### R1-F3 [minor]

Section 2 states AGENTS.md is "14 lines"; the actual file has 15 lines (including the trailing newline/blank). Trivial factual error, no functional impact.

- `exafyltd/vitana-platform:AGENTS.md:1` — # Repository Scope

Strict rule: Codex may only work with these GitHub repositories:
...
If a task appears to require another repository, stop and ask the user to confirm
that the repository scope rule should be changed before taking any action.

Suggestion: Correct to 15 lines.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
