---
lane: store-submission-owner
state: ready
next_actor: owner
depends_on: [prereq-exit, store-declarations]
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - docs/validation/native-wave3/store-submission.md
updated: 2026-11-07T10:33Z
---
# OWNER GATE — G3: store accounts, signing key and EAS cloud builds (not built)
Plan: `.kiro/specs/native-wave3-release/` — `plan.md` (owner gates) and the `tasks.md` section marked
`<!-- lane: store-submission-owner -->` (task O1) are authoritative.

**OWNER GATE — no session builds, signs or submits.** The owner confirms, in `docs/validation/native-wave3/store-submission.md`:
App Store Connect access (team `62Q26QSEJW`), Play Console access, the Android signing/upload key, and whether EAS cloud
builds are used (`NATIVE-APP-PLAN.md:118`, §2a G3; §8 decision 2 at `:219`). EAS cloud builds touch a governance
workflow and would need an `executor: claude` lane, so they are not in this spec.

**Next actor is the owner.** A session records the decision the owner gives and nothing more.

## Log
### 2026-11-07T10:33Z · kiro-exafyltd-202611062257-540e · created → ready (owner)
Drafted with the plan. Recorded as an owner gate; no credential, key or console action is taken.
