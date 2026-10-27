# Sparring round 2 — in_progress

Session: `a8274a3c-ae8f-4d4b-bd18-5ed3596a0246` · plan hash `f2d7e5dbaf6032ceab103f0f9675c4e3a203c531c0abffb563aabaa9fc3d2c83`

## Summary

The revised plan adequately resolves R1-F1 (Change types mechanism now specified via tasks.md first line + lane-review.md sentence) and R1-F2 (commit-coverage.json BOM fix added). R1-F3 is correctly rejected: the file exists at the pinned commit. One new blocker is raised: both `pipeline-quality` and `v1-pr-template` modify governance paths (`.github/**` and `scripts/collab/**`) but the plan never specifies `reviewer_seat: agent:vitana-lane-reviewer` in the lane files, which queue.mjs:701 requires for `executor: kiro` lanes on governance paths — a silent CI failure on the Lane scope check.

## Findings

### R2-F1 [blocker]

The `pipeline-quality` and `v1-pr-template` lane files must declare `reviewer_seat: agent:vitana-lane-reviewer` to pass the Lane scope CI check, but the plan never specifies this field and `planning.md` actively misleads implementers into omitting it.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:85` — export const GOVERNANCE_PATHS = ['.github/**', '.claude/**', '.kiro/steering/**', '.kiro/automations/**', 'scripts/collab/**',
  'CLAUDE.md', 'docs/programs/areas.yaml'];
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:71` — // VTID-05276 (plan kiro-autonomy-fallback §4.1): reviewer agents — a `reviewer_seat` value that is not a Kiro seat. A
// lane with `executor: kiro` and `reviewer_seat: agent:vitana-lane-reviewer` may change governance paths (never a
// protected gate file); its review entries come from the agent's own session id.
export const REVIEWER_AGENTS = ['agent:vitana-lane-reviewer'];
export const isReviewerAgent = (v) => REVIEWER_AGENTS.includes(v);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:697` — else if (fm.executor === 'claude') continue;
        // VTID-05276 (plan §4.3): a protected gate file never passes for a non-claude lane, whatever its reviewer.
        else if (matchesAny(f, PROTECTED_GATE_PATHS)) errors.push(`${f} is a protected gate file (governance path, scripts/collab/protected-gate-files.json); lane ${key} has executor ${fm.executor || 'unset'} (needs claude — an agent review cannot unlock it)`);
        else if (!matchesAny(f, GOVERNANCE_PATHS)) continue;
        else if (fm.executor === 'kiro' && isReviewerAgent(fm.reviewer_seat) && trustedFrom) continue;
        else errors.push(`${f} is a governance path; lane ${key} has executor ${fm.executor || 'unset'} (needs claude, or executor kiro with reviewer_seat ${REVIEWER_AGENTS[0]} from main or an approved plan( PR)`);
- `exafyltd/vitana-platform:.kiro/pipeline/planning.md:35` — `reviewer_seat` is legacy: set it only where the current `queue.mjs validate` still requires it (a different seat
  from `seat`). No two lanes edit the same file; a lane on a governance path follows the rule collaboration.md §3a
  states on `main` today.
- `exafyltd/vitana-platform:.github/pull_request_template.md:1` — <!--
VTID-05305 — PR body template.

Suggestion: The plan's §3 must explicitly state that both the `pipeline-quality` lane file (which touches `.github/pull_request_template.md` under `.github/**` and `scripts/collab/quality-checks.test.mjs` under `scripts/collab/**`) and the `v1-pr-template` lane file (which touches `.github/PULL_REQUEST_TEMPLATE.md` under `.github/**`) must declare `reviewer_seat: agent:vitana-lane-reviewer` in their front matter. The `quality-checks.test.mjs` structural test should also assert that the plan's two affected lane files carry this field, so the red-on-base detection covers it. Additionally, `planning.md`'s description of `reviewer_seat` should be updated to note the governance path exception: 'legacy for seat routing, but required as `agent:vitana-lane-reviewer` for any `executor: kiro` lane whose `paths` include a governance path (`.github/**`, `scripts/collab/**`, etc.)' — the current wording actively misleads a Kiro coder into omitting it.

## Acknowledgements of earlier responses

- R1-F3: acknowledged — The planner is correct. `list_dir .github/` at the pinned commit shows `pull_request_template.md` (lower-case) exists, and `read_file` confirms it is the 44-line VTID-05305 PR template. The lane edits an existing file, not creates one. Rejection is sound.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
