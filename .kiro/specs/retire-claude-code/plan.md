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
1. `scope-rules` (platform) — `queue.mjs` + tests. What code enforces (R1-F2/F3):
   - a lane may declare or change a governance path only with `governance: true`; such a lane's `seat` and
     `reviewer_seat` must both be seats listed in `docs/programs/areas.yaml`, and different (`claude` refused);
   - on a governance lane every build commit's session names the lane's `seat` and every review entry's session names
     `reviewer_seat` (`kiro-<seat>-…`). Unseated `kiro-YYYY…` ids and `session_…` ids are refused there;
   - a governance lane moving to `verified` or `done` needs a log entry with an `owner-instruction:` line (the
     owner's words + date) and a `merge:` line (merge SHA). This is the audit record of the human step;
   - lane permission fields (`executor`, `seat`, `reviewer_seat`, `paths`, `governance`) may change only in a `_plan`
     commit by a session of the plan's `author_seat`, and only in a PR that also changes that plan's `plan.md`, so
     PLAN-SPAR re-spars every permission change;
   - legacy `reviewer_seat: claude` on non-governance lanes accepts a named Kiro seat ≠ `seat`; `executor: claude`
     stays valid for existing lanes but is no longer created.
   **What code cannot enforce:** all Kiro accounts share the `exafyltd` GitHub identity, so a seat in a session id is
   self-declared and no check can tell two Kiro accounts apart. The seat rules keep honest sessions apart and make
   every step attributable. The real boundary for a governance change is the owner's explicit per-PR merge
   instruction, a human act no agent can produce. The plan states this rather than claiming more.
2. `rules-platform` (platform, governance) — `.claude/rules/collaboration.md` (§7 roles, §7a, §7b kept, new §7c
   production options, governance guard), `CLAUDE.md` roles paragraph, and the role text in exactly these steering
   files (R1-F5): `vitana-load-project-rules.md`, `vitana-kiro-notes.md`, `vitana-standing-rules.md` (:6),
   `vitana-collaboration.md` (title only; it stays a `#[[file:]]` link). `scripts/ci/kiro-steering/guard.cjs` must
   stay green;
   `.kiro/automations/*.md` (housekeeping from the routine moves to seat `exafyltd`'s run; every automation skips
   governance lanes and never merges or deploys), `routine-prompt.md` marked retired. `docs/programs/areas.yaml`
   unchanged.
3. `rules-v1` (vitana-v1, governance) — the same `collaboration.md` (byte-identical), `CLAUDE.md`, and the same four
   steering files.
4. `ci-runner-platform` (platform, governance) — `runs-on: ubuntu-24.04` on every job that runs a browser, whether the
   install is in the YAML or in a script: STAGING-VERIFY installs Chromium inside
   `scripts/ci/staging-verify/run.mjs:255`, not in its YAML (R1-F4). Files: `ANDROID-DEVICE-E2E.yml`,
   `E2E-ORB-MONITOR.yml`, `E2E-TEST-RUN.yml`, `MOBILE-DEVICE-E2E.yml`, `MORNING-SYSTEM-HEALTH-CHECK.yml`,
   `SCREEN-LOAD-TIMING.yml`, `STAGING-TESTS-REQUIRED.yml`, `STAGING-VERIFY-NIGHTLY.yml`, `STAGING-VERIFY.yml`,
   `VISUAL-VERIFY-FRONTEND.yml`. A new test `scripts/ci/playwright-runner-pin.test.mjs` scans `.github/workflows/`
   in both checkouts it is given. Any job on `ubuntu-latest` whose steps run `playwright install`,
   `@playwright/test`, `playwright test` or `staging-verify/run.mjs` fails it. It is wired into the PR-GATE step that
   already runs `node --test scripts/collab/queue.test.mjs` (`PR-GATE.yml:71`). No Playwright version change.
5. `ci-runner-v1` (vitana-v1, governance) — the same pin in `PR-GATE.yml`, `E2E-PREVIEW-ORB.yml`,
   `STAGING-TESTS-REQUIRED.yml`; the platform test is run against this checkout in the PR body.

Order: `scope-rules` first; then the other four in parallel (the two CI lanes first in practice: they unblock Gate 2
for every change, incl. VTID-05229).

## Bootstrap (R1-F1, verified 2026-10-20)
Today's checker (fetched from platform main) refuses every governance path from a Kiro lane, so this plan PR (Collab
handoff) and the `scope-rules` PR (Collab handoff, Lane scope) are red by construction. Neither check is a required
status check:
- vitana-platform `main` requires only `validate` (`ENFORCE-FRONTEND-CANONICAL-SOURCE.yml`), and it passes here;
- vitana-v1 `main` has no branch protection and no rulesets.

So GitHub merges these PRs with those checks red, and no `--admin` or override flag is needed. The only merger that
waits for a green Lane scope is the Project Manager, which is not live (`PM_MODE` dry_run). The bootstrap is
therefore exactly two merges, each on the owner's explicit per-PR instruction:
1. this plan PR;
2. the `scope-rules` PR. Its reviewer seat must confirm that every red line in Lane scope and Collab handoff is the
   old governance refusal and nothing else.

Both are recorded with the instruction and merge SHA. From then on, Lane scope is fetched from main with the new
rules and must be green for every lane.

## Tests
- `scope-rules`: `queue.test.mjs` cases for every new rule and every unchanged refusal (governance path without
  `governance: true`; governance lane with `reviewer_seat: claude` or = `seat`; permission change by another seat or
  outside `_plan`; legacy `executor: claude` lane still validates). `node --test scripts/collab/` green.
- Text lanes: `queue.mjs validate` green; `collaboration.md` byte-identical across repos (sha256 in the PR).
- CI lanes: `scripts/ci/playwright-runner-pin.test.mjs` green on both checkouts, and red on origin/main (negative
  control); the PR's own preview-e2e installs Chromium and runs; after merge STAGING-VERIFY for community-app at the
  latest main commit passes its browser step (first: VTID-05229 at 32a82e6b6 or later).
- No staging or production data touched; no test targets production.

## Risks
- Separation of duties now rests on seats + the owner's per-PR merge instruction, not on a second agent. Accepted
  by the owner; mitigated by the different-seat review and automations never touching governance lanes.
- (b) puts production dispatch in a Kiro session. Limited to an explicit "yes, deploy" to one Gate 2 message, pinned
  to the verified commit, recorded in the lane log; post-deploy check and automatic rollback (VTID-04647) unchanged.
- `ubuntu-24.04` will itself age out; the pin is explicit, so a later bump is one visible change.
<!-- plan:end -->
