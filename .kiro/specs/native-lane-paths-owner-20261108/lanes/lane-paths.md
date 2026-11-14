---
lane: lane-paths
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: tooling
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
lane_admin: true
repos: [exafyltd/vitana-platform]
paths:
  - .kiro/specs/native-wave2-events-calendar-r3/lanes/events-meetups.md
  - .kiro/specs/native-wave2-fix-forward-r2/lanes/public-entry.md
updated: 2026-11-10T10:45Z
vtid: VTID-05679
---
# Lane `lane-paths`: add the three test files the owner allowed to the `paths` of two native lanes
Tasks in `tasks.md` (group `<!-- lane: lane-paths -->`). VTID from PLAN-SPAR; never by hand.

Owner decision (final, 2026-11-08), two parts:
- Decision 2, lane `native-wave2-events-calendar-r3/events-meetups` (vitana-v1 #1608, VTID-05531): "You may change only the /admin/activity expectation in apps/mobile/tests/orb/nav-directive.test.ts. Record that route as a parity exception in the ledger. Make no other test edits in this lane."
- Decision 4, lane `native-wave2-fix-forward-r2/public-entry` (vitana-v1 #1646, VTID-05650): "You may update the 2 landing-page tests, limited to their landing-page assertions. The PR description must list each old and new assertion."

Both lane PRs are open and carry those edits, but the files are outside each lane's `paths`, so Lane scope [required] fails on
exactly them, and a lane PR cannot widen its own paths (`scripts/collab/queue.mjs` scopeCheck takes the paths from the
trusted revision). This is a `lane_admin` lane (VTID-05408): `executor: kiro`, `reviewer_seat: agent:vitana-lane-reviewer`,
and its `paths` are exactly the two target lane files (not its own file, so it can never change its own permissions).
It adds one `paths` line to the first target and two to the second; nothing else in either target changes.
Precedent: lane `nav-paths` (VTID-05563, PR #4722) and `say-hello-lane-reassign/reassign` (VTID-05410). Evidence under
`docs/validation/<this VTID>/`.
**Never** (collaboration §7a): no VTID allocation by hand, no merge/approve, no workflow dispatch or deploy, no write to
Supabase/AWS, no test against production, no `--admin`, no loosening of Lane scope.

## Log
### 2026-11-08T14:30Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-10T10:45Z · ci-plan-spar · ready (VTID allocated)
VTID-05679 allocated after policy approval (converged-auto-v1).
