---
lane: iap-decision-owner
state: ready
next_actor: owner
depends_on: [prereq-exit]
executor: kiro
seat: exafyltd
reviewer_seat: hotmail
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - docs/validation/native-wave3/iap-decision.md
updated: 2026-11-07T10:33Z
---
# OWNER GATE — payment classification per purchase type (§8 decision 4; not built)
Plan: `.kiro/specs/native-wave3-release/` — `plan.md` (owner gates) and the `tasks.md` section marked
`<!-- lane: iap-decision-owner -->` (task O2) are authoritative.

**OWNER GATE — no payment code is written.** The owner decides, per purchase type (subscriptions, credits, bookings,
tickets), whether StoreKit or Play Billing is introduced or the purchase stays outside the app
(`NATIVE-APP-PLAN.md:221` §8 decision 4; §2 item 5 at `:86`). The decision is recorded in
`docs/validation/native-wave3/iap-decision.md`. Store review for IAP follows that decision.

**Next actor is the owner.**

## Log
### 2026-11-07T10:33Z · kiro-exafyltd-202611062257-540e · created → ready (owner)
Drafted with the plan. Recorded as an owner gate.
