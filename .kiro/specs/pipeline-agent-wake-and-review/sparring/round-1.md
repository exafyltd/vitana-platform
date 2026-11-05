# Sparring round 1 — in_progress

Session: `6b6afa7f-87ba-457a-bb13-548332559c6e` · plan hash `bea2a5434c9f70e769a3fa8d514da85e95ae7990717c3a61737dffe405c1be7c`

## Summary

The plan is well-structured and addresses real latency bottlenecks. Most premises about the codebase check out. I found one blocker-level issue with the independent-reviewer governance-path exclusion that would make the feature effectively useless, a major issue with an incorrect premise about `isAgentReview`, and two minor issues.

## Findings

### R1-F1 [blocker]

Lane 2 condition (c) blocks the independent reviewer for lanes touching `.kiro/**`, but this is vastly broader than the existing GOVERNANCE_PATHS (`.kiro/steering/**` and `.kiro/automations/**`). Nearly every lane PR updates its lane file under `.kiro/specs/<slug>/lanes/<lane-id>.md` and/or the handoff at `.kiro/specs/<slug>/handoff.md`. With the `.kiro/**` exclusion, the independent reviewer would be blocked on virtually every lane, making the feature dead on arrival.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:85` — export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**',
  'CLAUDE.md', 'docs/programs/areas.yaml'];
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:64` — export const GOVERNANCE_PATHS = [
  '.github/',
  '.claude/',
  '.kiro/steering/',
  '.kiro/automations/',
  'scripts/collab/',
  'CLAUDE.md',
  'docs/programs/areas.yaml',
] as const;
- `exafyltd/vitana-platform:.kiro/pipeline/planning.md:35` — - `lanes/<lane-id>.md`: `state: ready`, `next_actor: kiro`, `executor`, `seat`, `reviewer: agent:vitana-lane-reviewer
  (claude-sonnet-5.5)`, `paths`, `depends_on` (real file/API dependencies only), `repos`; a log entry "created".

Suggestion: Use the existing GOVERNANCE_PATHS definition (`.kiro/steering/**` and `.kiro/automations/**`) rather than the broad `.kiro/**` for condition (c). The agent files and protected gate files are already covered by the protected-gate-file check (condition (c) sub-clause 'such lanes keep waiting for a chain model' is redundant for those). Alternatively, if a broader restriction is intentional, explicitly carve out `.kiro/specs/**` so lane-file updates don't block the independent reviewer.

### R1-F2 [major]

The plan states `isAgentReview` (governance.ts:130-135) accepts 'only `agent:vitana-lane-reviewer (<chain model>)`'. In reality, `AGENT_REVIEWER_VALUES` at line 130 also includes the bare `REVIEWER_AGENT` string (`agent:vitana-lane-reviewer` without a model suffix). This incorrect premise could lead the implementer to model the new independent identity check incorrectly — e.g., not deciding whether `agent:vitana-lane-reviewer-independent` (bare) should also be accepted, or failing to test that path.

- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:26` — export const REVIEWER_AGENT = 'agent:vitana-lane-reviewer';
- `exafyltd/vitana-platform:services/gateway/src/services/project-manager/governance.ts:129` — const AGENT_REVIEWER_VALUES = new Set([REVIEWER_AGENT, ...REVIEWER_AGENT_MODELS.map((m) => `${REVIEWER_AGENT} (${m})`)]);

/** An `accept` written for the reviewer agent (exact identity; `agent:someone-else`, `…-fake`, null never count). */
export function isAgentReview(r: ReviewEntry): boolean {
  return r.verdict === 'accept' && typeof r.reviewer === 'string' && AGENT_REVIEWER_VALUES.has(r.reviewer.trim());
}

Suggestion: Correct the premise to note that `isAgentReview` also accepts the bare `agent:vitana-lane-reviewer`. Explicitly state whether the new `isAgentIndependentReview` (or equivalent) should accept the bare `agent:vitana-lane-reviewer-independent` in addition to the `(<model>)` forms. Add a test case for the bare form either way.

### R1-F3 [minor]

Lane 1 says 'Slug parsed with the queue's `SLUG_RE`', but `SLUG_RE` in queue.mjs (line 57) is a module-private `const`, not exported. The same is true in plan-driver.mjs (line 39). `driver-wake.mjs` cannot import it without either (a) exporting it from queue.mjs (a protected gate file change not scoped to lane 1) or (b) duplicating the regex.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:57` — const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
- `exafyltd/vitana-platform:scripts/collab/plan-driver.mjs:39` — const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

Suggestion: Clarify that driver-wake.mjs will define its own copy of SLUG_RE (like plan-driver.mjs does), or scope a queue.mjs export into lane 2 (which already edits that file). If the latter, add a parity test.

### R1-F4 [minor]

The plan cites guard.cjs:119 for the agent's `Model chain:` line, but the actual line is 123.

- `exafyltd/vitana-platform:scripts/ci/kiro-steering/guard.cjs:119` — 'Collab-Session:', 'Collab-Review:', 'Collab-Verdict:',
    'Collab-Reviewer: agent:vitana-lane-reviewer (<model>)', 'Collab-Reviewed-Head:',
    'protected-gate-files.json',
    `Model chain: ${REVIEWER_MODELS.map((m) => '`' + m + '`').join(' → ')}`,

Suggestion: Update the line reference to :123.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
