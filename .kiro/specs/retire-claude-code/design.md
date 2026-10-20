# Design — retire-claude-code

## 1. `scripts/collab/queue.mjs` (lane `scope-rules`)
- `validateLane`: replace the `executor === 'kiro'` + governance-glob error (:180) with: a governance glob requires
  `governance: true`; a lane with `governance: true` requires `reviewer_seat` to match `SEAT_RE` and differ from `seat`
  (`claude` refused). `executor: claude` lanes stay valid unchanged (legacy).
- `scopeCheck`:
  - governance file from a lane without `governance: true` → error (was: from a non-claude lane);
  - permission fields (`executor`, `seat`, `reviewer_seat`, `paths`, and the new `governance`) may differ from the base
    revision only when every commit touching the lane file is a `_plan` commit (`Collab-Lane: <slug>/_plan`) by a
    session whose seat equals the plan's `author_seat`, or (legacy) a `session_…` commit on an `executor: claude` lane;
  - `reviewer_seat: claude` review entries: accept a Kiro session whose seat ≠ lane `seat` (and still `session_…`).
- governance lanes (`governance: true`): `seat` and `reviewer_seat` must be keys of `seats:` in
  `docs/programs/areas.yaml` and differ; build commits must come from `kiro-<seat>-…` sessions, review entries from
  `kiro-<reviewer_seat>-…`; unseated and `session_…` ids refused; a move to `verified`/`done` requires a log entry with
  `owner-instruction:` and `merge:` lines;
- permission changes additionally require the same PR to change the plan's `plan.md` (so PLAN-SPAR re-spars them);
- `GOVERNANCE_PATHS` unchanged.

## 2. Rule text (lanes `rules-platform`, `rules-v1`)
- `collaboration.md` §7: roles without Claude Code; §7a list unchanged except "the Project Manager merges" →
  "merges only under §7b"; §7b kept verbatim; new **§7c** = R2 (production a/b) and R3 (governance guard); §8 drops
  the Claude Routine and adds the housekeeping step to the `exafyltd` automation.
- `CLAUDE.md` roles paragraph: the same, short, pointing to §7–§7c; the Autonomy Contract's "Yes at Gate 2 →
  dispatch" line gets "(only per §7c: an explicit 'yes, deploy' to that Gate 2 message)".
- Steering (`vitana-load-project-rules.md`, `vitana-kiro-notes.md`): role text + §7c.
- Automations: step 1 forbids governance lanes, merges and deploys; `exafyltd` gains step "D. Housekeeping"
  (= routine steps 4 and the `review: changes` hand-back), at most one item per run like A–C.
- `routine-prompt.md`: one-line header "Retired 2026-10-20 (retire-claude-code); kept for history."

## 3. CI runner pin (lanes `ci-runner-platform`, `ci-runner-v1`)
In each listed workflow, every job whose steps run `playwright install`, `@playwright/test`, `playwright test` or
`scripts/ci/staging-verify/run.mjs` (which installs Chromium at :255): `runs-on: ubuntu-latest` →
`runs-on: ubuntu-24.04`. Other jobs untouched. `scripts/ci/playwright-runner-pin.test.mjs` (node:test) enforces it and
runs in PR-GATE next to `queue.test.mjs`.

## 4. Tests
`scripts/collab/queue.test.mjs` (`node --test`), one case per rule in §1 including the unchanged refusals. CI lanes
are proven by their own preview-e2e run and the next STAGING-VERIFY.
