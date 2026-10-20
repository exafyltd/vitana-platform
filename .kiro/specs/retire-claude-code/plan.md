# Plan — retire-claude-code

Author: Kiro, session `kiro-exafyltd-202610201041-ab5d`, seat `exafyltd`. Spans `exafyltd/vitana-platform` and
`exafyltd/vitana-v1`. Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this folder.

<!-- plan:begin -->
## Goal
Owner decision 2026-10-20: *"let's eliminate Claude Code completely … so everything is done by Kiro."* Every job Claude
Code still holds moves to Kiro seats, and every safeguard that relied on Claude Code being a second agent gets a
replacement. Nothing becomes less protected than today.

## Owner decisions (2026-10-20, in the conversation)
1. **Production after Gate 2 — either option, chosen per change by the owner's answer:**
   (a) the owner presses PUBLISH in the Command Hub; or (b) the owner answers the Gate 2 message with an explicit
   "yes, deploy" and the Kiro session dispatches the production workflow pinned to the verified commit. A bare or
   standing "yes" is not (b); no unattended run ever deploys.
2. **Governance paths** (`.github/**`, `.claude/**`, `.kiro/steering/**`, `.kiro/automations/**`, `scripts/collab/**`,
   `CLAUDE.md`, `docs/programs/areas.yaml`): a Kiro lane may change them when the lane says `governance: true`. Such a
   PR merges only on the owner's explicit per-PR instruction and with an approving review from a different Kiro seat
   on the current head. Automation runs never build, review-approve or merge a governance lane.

## Measured state (origin/main, 2026-10-20)
- `scripts/collab/queue.mjs`: `GOVERNANCE_PATHS` may only be changed by `executor: claude` lanes (`validateLane` :180,
  `scopeCheck` :471); lane permission fields (`executor`, `seat`, `reviewer_seat`, `paths`) only by `session_…`
  sessions (:448-460); `reviewer_seat: claude` only accepts `session_…` reviews (:479).
- `scripts/collab/routine-prompt.md`: Claude Routine, 3×/weekday — stale-claim cleanup, `executor: claude` lanes,
  merging verified lanes, `review: changes` hand-backs, VTID allocation when PLAN-SPAR does not, parked items.
- PLAN-SPAR (Bedrock Opus 4.6) spars and policy-approves; the Project Manager agent is installed but `PM_MODE` defaults
  to `dry_run` and its act lane (`pm-agent/p4-act`) is not built. Merging today: §7b per-PR owner instruction.
- Every Playwright job runs on `ubuntu-latest`, now Ubuntu 26.04, where Playwright 1.51.0 has no Chromium
  (`ERROR: Playwright does not support chromium on ubuntu26.04-x64`): STAGING-VERIFY fails for every change
  (community-app run 39397664080, gateway run 39398336187). 10 workflows in vitana-platform, 3 in vitana-v1.

## Changes (5 lanes)
1. `scope-rules` (platform) — `queue.mjs` + tests: a lane with `governance: true` and `executor: kiro` may declare and
   change governance paths; `validate` then requires `reviewer_seat` to be a Kiro seat ≠ `seat` (never `claude`).
   Lane permission fields may change in a `_plan` commit by a session of the plan's `author_seat`. `reviewer_seat:
   claude` on existing lanes accepts a review from any Kiro seat ≠ `seat`. `executor: claude` stays valid (no data
   migration) but is no longer created. Everything else in validate/scope-check is unchanged.
2. `rules-platform` (platform, governance) — `.claude/rules/collaboration.md` (§7 roles, §7a, §7b kept, new §7c
   production options, governance guard), `CLAUDE.md` roles paragraph, `.kiro/steering/*` role text,
   `.kiro/automations/*.md` (housekeeping from the routine moves to seat `exafyltd`'s run; every automation skips
   governance lanes and never merges or deploys), `routine-prompt.md` marked retired. `docs/programs/areas.yaml`
   unchanged.
3. `rules-v1` (vitana-v1, governance) — the same `collaboration.md` (byte-identical), `CLAUDE.md`, steering.
4. `ci-runner-platform` (platform, governance) — `runs-on: ubuntu-24.04` on every job that installs Playwright, in the
   10 workflows. No Playwright version change, no test change.
5. `ci-runner-v1` (vitana-v1, governance) — the same pin in `PR-GATE.yml`, `E2E-PREVIEW-ORB.yml`,
   `STAGING-TESTS-REQUIRED.yml`.

Order: `scope-rules` first; then the other four in parallel (the two CI lanes first in practice: they unblock Gate 2
for every change, incl. VTID-05229).

## Bootstrap
Today's Lane scope check (fetched from platform main) refuses every governance path from a Kiro lane, so the
`scope-rules` PR — and this plan PR's lane files, which `validate` flags — fail Collab handoff / Lane scope by
construction. That is the governance-artifact false positive §7b allows the owner to `--admin`-override, on an
explicit per-PR instruction. After `scope-rules` is on main the override is never needed again.

## Tests
- `scope-rules`: `queue.test.mjs` cases for every new rule and every unchanged refusal (governance path without
  `governance: true`; governance lane with `reviewer_seat: claude` or = `seat`; permission change by another seat or
  outside `_plan`; legacy `executor: claude` lane still validates). `node --test scripts/collab/` green.
- Text lanes: `queue.mjs validate` green; `collaboration.md` byte-identical across repos (sha256 in the PR).
- CI lanes: the PR's own preview-e2e installs Chromium and runs; after merge STAGING-VERIFY for community-app at the
  latest main commit passes its browser step (first: VTID-05229 at 32a82e6b6 or later).
- No staging or production data touched; no test targets production.

## Risks
- Separation of duties now rests on seats + the owner's per-PR merge instruction, not on a second agent. Accepted
  by the owner; mitigated by the different-seat review and automations never touching governance lanes.
- (b) puts production dispatch in a Kiro session. Limited to an explicit "yes, deploy" to one Gate 2 message, pinned
  to the verified commit, recorded in the lane log; post-deploy check and automatic rollback (VTID-04647) unchanged.
- `ubuntu-24.04` will itself age out; the pin is explicit, so a later bump is one visible change.
<!-- plan:end -->
