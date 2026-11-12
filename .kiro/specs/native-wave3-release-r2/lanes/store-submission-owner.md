---
lane: store-submission-owner
state: ready
next_actor: kiro
depends_on: [prereq-exit, store-declarations]
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - docs/validation/native-wave3/store-submission.md
updated: 2026-11-08T12:07Z
vtid: VTID-05664
---
# OWNER GATE — G3: store accounts, signing key and EAS cloud builds (not built)
Plan: `.kiro/specs/native-wave3-release-r2/` — `plan.md` (owner gates) and the `tasks.md` section marked
`<!-- lane: store-submission-owner -->` (task O1) are authoritative.

**OWNER GATE — no session builds, signs or submits.** The owner confirms, in `docs/validation/native-wave3/store-submission.md`:
App Store Connect access (team `62Q26QSEJW`), Play Console access, the Android signing/upload key, and whether EAS cloud
builds are used (`NATIVE-APP-PLAN.md:118`, §2a G3; §8 decision 2 at `:219`). EAS cloud builds touch a governance
workflow and would need an `executor: claude` lane, so they are not in this spec.

**Next actor is the owner.** A session records the decision the owner gives and nothing more.

## Log
### 2026-11-08T12:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave3-release/store-submission-owner`, PR #4770).

### 2026-11-08T12:07Z · ci-plan-spar · ready (VTID allocated)
VTID-05664 allocated after policy approval (converged-auto-v1).
