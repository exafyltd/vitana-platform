---
slug: fix-deeplink-scroll-test
author: kiro
author_seat: dstev
executor: kiro
next_actor: kiro
state: approved
updated: 2026-10-28T13:11Z
sparring_record: .kiro/specs/fix-deeplink-scroll-test/sparring/verdict.md
vtids: [VTID-05394]
---
# Handoff — fix-deeplink-scroll-test
vitana-v1 `Vitest (jsdom)` must be green on main. The deep-link test's `@/lib/i18n-toast` mock the owner named was
already fixed by VTID-05313 (#1473, 2026-10-21); main is red again since 2026-10-28T10:01Z because the VTID-05320
send-status test seeds outbox items with fixed 2026-10-21 dates that the 7-day prune now drops. This plan makes those
fixture dates relative to now. Test-only, one lane, in vitana-v1.
Plan: `plan.md`. Tasks: `tasks.md`.
Lanes:
- `fixture-dates`: repo `exafyltd/vitana-v1`, executor **kiro**, reviewer `agent:vitana-lane-reviewer`.
## Log
### 2026-10-28T10:20Z · kiro-dstev-202610280954-a005 · drafted
Written for the owner task of run `wf_41f1175f2cb86d49` from the read-only investigation (vitana-v1 `origin/main`
`5bc8d10cd`, UNIT-TESTS runs 40511463300 green / 40668786443 red). Owner's named mock already fixed on main (recorded
in `plan.md` § Today 1); the lane fixes the current cause of the red check. Next: PLAN-SPAR spars this PR.

### 2026-10-28T13:11Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
