---
slug: messenger-vitana-cards
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: claude
state: parked
sparring_record: .kiro/specs/messenger-vitana-cards/sparring/
owner_approval: .kiro/specs/messenger-vitana-cards/sparring/owner-approval.md
updated: 2026-10-27T22:49Z
parked_from: approved
---

Deeply-personalized, one-per-day Vitana recommendation cards in the direct
Vitana chat, delivered by the existing Vitana Companion Messages engine. Phase 1
wires the 11 enrichment cards + F1/F7/F8 + two weekly reminders, all gated on
existing signals. Phase 2 (held) adds the usage-gated F4/F5/F10 once their
signals exist. Lab tests are a separate follow-up plan.

### 2026-10-22T08:05Z · kiro-exafyltd-202610220802-4a74 · drafted
Plan authored from the messenger-vitana-cards investigation
(`.agents/tasks/messenger-vitana-cards-investigation/findings.md`). Three lanes
created (all `ready`): companion-enrichment-moments, companion-weekly-reminders
(depends on the first), messenger-surface-wiring (depends on the first).
Owner decisions recorded in plan.md §1: one card per day, lab tests out of
scope, F4/F5/F10 held for Phase 2.
Next: push the `plan(messenger-vitana-cards)` PR so CI PLAN-SPAR spars it and
allocates the lane VTIDs on convergence.

### 2026-10-22T08:20Z · kiro-exafyltd-202610220802-4a74 · drafted (sparring round 1 answered)
CI PLAN-SPAR round 1 raised 3 blockers + 3 majors + 2 minors — all verified
against the code and ACCEPTED. Rewrote the plan:
- Removed F1/F7/F8 and the Index/diary weekly moments from scope (already
  shipped in VTID-05101; re-adding would duplicate and corrupt pickMoment).
- Dropped the `companion-weekly-reminders` lane.
- Added `companion-enrichment-signals` lane (bulk completion + dismissal reads;
  the per-member resolver has no bulk form — the real work).
- Gated the E1–E11 moments through `eligibleEnrichmentCards` (completion AND
  dismissal), not completion alone.
- Replaced the impossible staging assertion with the `disabled-on-staging`
  status pattern.
- Reworded the summary (no "never writes a diary entry"; diary nudge is
  lapsed-habit only).
Lanes now: companion-enrichment-signals → companion-enrichment-moments →
messenger-companion-verification. Responses in sparring/responses-1.md.
Next: push to start round 2.

### 2026-10-22T11:30Z · kiro-exafyltd-202610220802-4a74 · drafted (sparring round 2 answered)
CI PLAN-SPAR round 2: 1 blocker + 1 major + 1 minor — all verified and ACCEPTED.
- R2-F1 (blocker): must pass `unavailableEnrichmentCards()` as the 5th arg to
  `eligibleEnrichmentCards`; with Meta OAuth unset (every current stack) E6/E7
  are hidden, else a Connect-Instagram DM would 400 on tap.
- R2-F2 (major): the `FetchEnrichmentCompletions` seam must use allSettled /
  `unavailable[]` and never throw, or a DB error aborts the whole tick.
- R2-F3 (minor): don't use the 1-based catalog priority as the moment priority;
  assign explicit companion-scale 20–49, E1 highest → E11 lowest.
Plan, both affected lanes, and tasks updated. Responses in
sparring/responses-2.md. Next: push to start round 3 (cap is 3 rounds for a
standard change).

### 2026-10-22T12:10Z · kiro-exafyltd-202610220802-4a74 · drafted → approved (owner override)
CI PLAN-SPAR round 3 verdict was `escalated` — the 3-round cap was reached, not
a dispute. The partner acknowledged all round-2 findings as fully addressed and
raised two new ones (R3-F1 major: dismissal-cooldown `now` not reachable inside
`Moment.build`; R3-F2 minor: intent vs. display copy). Both verified and
accepted; plan/lanes/tasks updated (responses-3.md).

**Owner decision (this conversation, 2026-10-22): Option B — approve the plan
as-is with the two round-3 fixes applied.** Owner override of the escalated
verdict. The owner was presented the escalation with both findings and a
recommendation; the owner chose to proceed without another sparring cycle.

State set to `approved`. Lanes ready: companion-enrichment-signals →
companion-enrichment-moments → messenger-companion-verification.

**VTID allocation note:** the `vtid_ledger` trigger requires an
escalated+owner-approved (or converged+policy-approved) sparring record. This
record is `escalated` with the owner override recorded above and in
responses-3.md. CI allocates the lane VTIDs — Kiro does not hand-allocate.
Next: push; if CI does not auto-allocate on an owner-approved escalation, the
override is on record for the exceptions path / PM to allocate against.

### 2026-10-22T12:40Z · kiro-exafyltd-202610220802-4a74 · approved → drafted (CI re-sparred)
The round-3 fixes changed the plan text, so CI PLAN-SPAR opened a FRESH sparring
session (session 2, `b4758055…`, `s2-round-1.md`) rather than honouring the
owner-override escalation on the old text. This is the cleaner path: if session
2 converges, the record is converged + policy-approved and VTIDs allocate
automatically (no override needed). State returned to `drafted`.

Session 2 round 1: 1 blocker + 2 majors + 2 minors — all verified and ACCEPTED
(s2-responses-1.md):
- R1-F1 (blocker): adding 11 moments breaks the VTID-05101 "every moment" test
  3 ways; the moments lane updates that test in-PR.
- R1-F2 (major): set each moment's `topic` — null for setup cards,
  'community' for E3/E6/E7.
- R1-F3 (major): bulk seam must false-initialize all 11 per member, else a
  no-profile-row member gets zero cards (`undefined !== false`).
- R1-F4 (minor): diary_nudge is 40–50; enrichment band corrected to 21–39.
- R1-F5 (minor): VTID attribution (CI allocates).
Next: push to start session-2 round 2.

### 2026-10-22T13:10Z · kiro-exafyltd-202610220802-4a74 · drafted (session-2 round 2 answered)
Session 2 round 2: 1 blocker + 1 major + 1 minor — all verified and ACCEPTED
(s2-responses-2.md):
- R2-F1 (blocker): §2 said 21–39 but §3 still said 20–49 (undid R1-F4). Now
  21–39 everywhere; §2 table lists explicit priorities 29–39.
- R2-F2 (major): no repeatAfterDays → a card fires daily. Set 4 for
  E1/E2/E4/E5/E11, 7 for E3/E6/E7/E8/E9/E10; added a no-re-offer test.
- R2-F3 (minor): the 5th arg is not TS-enforced; the companion call site passes
  `unavailableEnrichmentCards()` explicitly with a test proving no E6/E7 when
  Meta env is unset.
Plan §2 table now carries topic + repeatAfterDays + priority per card. Next:
push to start session-2 round 3 (final round of this session).

### 2026-10-22T21:05Z · kiro-exafyltd-202610220802-4a74 · drafted → approved (OWNER APPROVAL)
Owner approved the plan as-is ("approve it", 2026-10-22) — Gate-1 approval and
override of the stuck session-2 sparring state (CI could not emit a round-3
verdict after a rebase interleaved CI's round-2 question with the planner's
round-2 answer; three safe re-triggers did not queue a new run). The plan is
converged in substance: 13 findings across 2 sessions, all verified and fixed.
Approval recorded in sparring/owner-approval.md. State set to `approved`.

Lanes ready (ordered): companion-enrichment-signals →
companion-enrichment-moments → messenger-companion-verification.

VTID allocation: Kiro does not hand-allocate (§7a). The owner-approved record is
now in place; allocation proceeds via CI PLAN-SPAR on the approved record or the
PM/exceptions path citing owner-approval.md. This approval does NOT enable live
member sends (engine stays disabled-on-staging / off in prod — separate
go-live).
Next: push the approval; verify CI allocates the three lane VTIDs; then the
signals lane can start.

### 2026-10-27T22:49Z · ci-plan-spar · approved → parked
Not converged after 2 sparring sessions (round_cap_reached). Parked with the open findings in sparring/.
