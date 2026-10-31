# Tasks — quality-checks-followup
Authoritative plan: `plan.md` (between the plan markers). Lane files under `lanes/`. VTIDs: allocated by CI PLAN-SPAR
after policy approval; never by hand. Branch `kiro/quality-checks-followup/<lane>` (`claude/…` for the claude lane),
PR title `VTID-xxxxx (quality-checks-followup/<lane>): …`, trailers `Collab-Session` + `Collab-Lane`, identity
`kiro-agent[bot]` for Kiro commits, evidence in `docs/validation/<VTID>/` (`acceptance.md`, `commands.log`,
`red-on-base.txt`, `outputs/`). Squash merge. Acceptance follows `.kiro/pipeline/quality-checks.md`.

<!-- lane: merge-policy-text -->
## Lane `merge-policy-text` — vitana-platform
- [ ] T1 Append the plan §3 test to `scripts/collab/quality-checks.test.mjs`; red on `origin/main` recorded.
- [ ] T2 Edit the Merge section of `.kiro/pipeline/quality-checks.md`, `docs/DEPLOYMENT-PIPELINE.md:155`, the comment
      at `scripts/ci/staging-verify/lib.cjs:240-245`.
- [ ] T3 `node --test scripts/collab/*.test.mjs`, `node --test scripts/ci/staging-verify/lib.test.cjs`, preflight.

**Acceptance**
- Change types: Tooling/docs
- Outcome: a session choosing a merge method finds one answer (squash), its sources (PM `act.ts`, `planning.md`), and
  why a default GitHub merge commit fails rule 47; no document says otherwise.
- States: n/a — no runtime behaviour. Surfaces: n/a — no UI. Locales: n/a — English rule text. Accessibility: n/a —
  no UI. Contract: n/a beyond the PM `act.ts` strategy the test pins.
- Staging proof: n/a — deploys nothing; proven by the test.
- `lib.cjs` changes in a comment only; `lib.test.cjs` unchanged and green.
- Only the lane's `paths` change.

<!-- lane: steering-quality-checks -->
## Lane `steering-quality-checks` — vitana-platform
- [ ] T1 Test in `scripts/collab/kiro-web-steering.test.mjs`; red on `origin/main` recorded.
- [ ] T2 Add `.kiro/pipeline/quality-checks.md` as the last `DRIVER_LINKS` entry; update `docs/kiro/kiro-web-bootstrap.md`.
- [ ] T3 Generate into an empty workspace (`--workspace`), then `--check`; record the byte total.
- [ ] T4 Fresh-session probe (plan §3) after regenerating the session workspace; record the answer in
      `docs/validation/<VTID>/outputs/fresh-session-probe.txt`.
- [ ] T5 `node --test scripts/collab/*.test.mjs`, `node --test scripts/ci/kiro-steering/guard.test.cjs`,
      `node scripts/ci/kiro-steering/guard.cjs .`, preflight.

**Acceptance**
- Change types: Tooling/docs
- Outcome: a new Kiro Web session's always-included steering carries `quality-checks.md`, and a fresh session can
  name the Acceptance template fields without reading the file (or the evidence says it was truncated, and why).
- States: the generator's `--check` stays green; a missing link still fails `--check`.
- Surfaces: n/a — no UI. Locales: n/a. Accessibility: n/a. Contract: n/a — the generated file format is unchanged
  apart from one more `#[[file:]]` line.
- Staging proof: n/a — deploys nothing; proven by the test, the generator run and the probe.
- No change to `kiro-web-session.mjs`, `preflight.mjs`, `AGENTS.md`, `driver.md` (plan `kiro-web-reliability`).
- Only the lane's `paths` change.

<!-- lane: reviewer-requester-rule -->
## Lane `reviewer-requester-rule` — vitana-platform (protected gate file)
- [ ] T1 Write `scripts/collab/reviewer-independence.test.mjs`; red on `origin/main` recorded.
- [ ] T2 Replace `.kiro/agents/vitana-lane-reviewer.md:43-44` as plan §3 states; no other line changes.
- [ ] T3 `node --test scripts/collab/*.test.mjs`, `node --test scripts/ci/kiro-steering/guard.test.cjs`,
      `node scripts/ci/kiro-steering/guard.cjs .`, preflight.
- [ ] T4 PR body lists the conflicting instructions (plan §2 C) and the residual risk (plan §6).

**Acceptance**
- Change types: Tooling/docs
- Outcome: a lane built by a Kiro Web driver can get an accept when the driver requests the review, while a review
  whose reviewer session is in the lane's executing log is still refused.
- States: a missing, malformed or executing-log reviewer session id → `changes` with one blocking finding.
- Surfaces: n/a — no UI. Locales: n/a. Accessibility: n/a.
- Contract: verdict JSON and review-entry format unchanged; collaboration.md §3 unchanged.
- No checklist item, hard limit, model chain or protected-file rule removed or loosened; "add checks, never waive one"
  and "spec and evidence from git" added.
- Staging proof: n/a — deploys nothing; proven by the test.
- Merges only with a legacy `claude` review on the current head or an owner instruction naming this plan.
- Only the lane's `paths` change.
