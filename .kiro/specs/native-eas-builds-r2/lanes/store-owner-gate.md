---
lane: store-owner-gate
state: ready
next_actor: kiro
depends_on: []
executor: kiro
area: frontend
seat: exafyltd
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - docs/validation/g3/**
updated: 2026-11-08T12:11Z
vtid: VTID-05669
---
# Owner records for G3: store, signing and Expo accounts (decisions 3, 4, 5, 6; owner inputs O1–O6)
Plan: `.kiro/specs/native-eas-builds-r2/` — `plan.md` ("Owner-gated inputs") and the `tasks.md` section marked
`<!-- lane: store-owner-gate -->` are authoritative.

**This lane has no code.** The owner completes it, and Kiro only records the result. The owner gives O1 to O6 and
Kiro writes the outcome into `docs/validation/g3/<item>.md` for the audit trail. The owner does not run a `gh workflow`
command: Kiro takes the steps once the input is in place (`collaboration.md` §7d).

**What the owner provides (never in the repository):**
- O1 Expo account, `EXPO_TOKEN` secret on `vitana-v1`, EAS plan and credit budget.
- O2 Apple: App Store Connect access (team `62Q26QSEJW`), Apple Developer membership, iOS bundle identifier (final,
  cannot change later), App Store Connect API key stored in EAS, app record created.
- O3 Google: Play Console access, Android package name (final), upload-key choice (EAS-managed or exported), Play
  service account key file stored in EAS.
- O4 G1 provisioned (`native-g1-wiring` `real-g1-switch`).
- O5 Tester groups: the internal TestFlight group and the Play internal testers list.
- O6 Decision on a production profile: default "none" until the owner decides after G3.

**Acceptance (reviewer = agent:vitana-lane-reviewer):**
- Change types: Tooling/docs.
- Outcome: each O-item has a dated record in `docs/validation/g3/` that says "done" or "open", with the owner's
  decision and the account or app name where it is not secret. The record contains no key, token, password or
  secret path.
- Records for the G3 contingency (new listings with new identifiers, `NATIVE-APP-PLAN.md:118`) are added only if the owner
  chooses that path.
- Staging proof: not verified on staging: owner records have no runtime effect; proven by the reviewer check that no
  secret value appears in the files.
- `docs/validation/<VTID>/` is not required: this lane writes `docs/validation/g3/**` only.

**Never:** the lane never stores credentials; never uploads anything; never writes to a store, Supabase, AWS or the
gateway.

## Log
### 2026-11-08T11:48Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-eas-builds/store-owner-gate`, PR #4771).

### 2026-11-08T12:11Z · ci-plan-spar · ready (VTID allocated)
VTID-05669 allocated after policy approval (converged-auto-v1).
