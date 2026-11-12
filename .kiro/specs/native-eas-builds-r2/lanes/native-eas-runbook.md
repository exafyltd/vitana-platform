---
lane: native-eas-runbook
state: ready
next_actor: kiro
depends_on: [eas-build-workflow, eas-submit-workflow]
executor: kiro
area: frontend
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/README.md
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:11Z
vtid: VTID-05668
---
# Runbook section in `apps/mobile/README.md` (decision 8; owner inputs O1–O6)
Plan: `.kiro/specs/native-eas-builds-r2/` — `plan.md` and the `tasks.md` section marked `<!-- lane: native-eas-runbook -->`
are authoritative. VTID: assigned by CI after PLAN-SPAR converges.

**Goal.** A new section "EAS builds and store uploads" in `apps/mobile/README.md`, placed after "What waits for which
gate". It states: which profiles exist and what each one is for; how to start a build and an upload (the two
workflows, by hand); which owner inputs O1–O6 each step needs; that no production profile exists and why. It links
to `plan.md` and `docs/validation/g3/`. The "What waits for which gate" table stays as it is, unless a row is now
wrong.

**Acceptance (reviewer = agent:vitana-lane-reviewer):**
- Change types: Tooling/docs.
- Outcome: someone opening the README can see which step waits for which owner input, and does not look for a
  production profile.
- States, Surfaces, Locales, Accessibility, Contract: n/a: a markdown file with no UI, no locale string and no
  boundary crossed.
- Links resolve (`plan.md`, `docs/validation/g3/`, both workflow files).
- Staging proof: n/a: documentation deploys nothing; proven by the link check and by the reviewer comparing the
  section with `eas.json` and the two workflow files.
- `docs/validation/<VTID>/{scope.json, staging-tests.json, plan-sparring.md}` added; `staging-tests.json` is read-only.

**Never:** the runbook never contains a secret value, a token, an account password, or a real production host.

## Log
### 2026-11-08T11:48Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-eas-builds/native-eas-runbook`, PR #4771).

### 2026-11-08T12:11Z · ci-plan-spar · ready (VTID allocated)
VTID-05668 allocated after policy approval (converged-auto-v1).
