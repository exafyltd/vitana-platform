---
slug: native-followups-20261111
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-11-11T12:56Z
sparring_record: .kiro/specs/native-followups-20261111/sparring/verdict.md
vtids: [VTID-05724, VTID-05725, VTID-05726, VTID-05727, VTID-05728]
---
# Handoff — Native follow-ups (2026-11-11)

Owner-approved follow-ups to the native app (vitana-v1 `apps/mobile/`), one plan. Plan block: `plan.md`. Tasks: `tasks.md`. Lanes: `lanes/*.md` (5).

## State at drafting
- Written against vitana-v1 origin/main `f2d652001` and vitana-platform origin/main `6dc6e1ba0`. No VTID is allocated. Lanes are `state: ready` with no `vtid:` field;
  CI PLAN-SPAR spars the `plan(native-followups-20261111)` PR and allocates VTIDs on convergence.
- Buildable: `partner-orgs-path`, `my-groups-deeplink`, `i18n-rtl-deterministic`, `translations` (Turkish only). `screen-backfill` is buildable only after
  vitana-v1 PR #1639 merges and after `my-groups-deeplink`; it supersedes lane `native-wave2-fix-forward-r2/screen-backfill` (VTID-05651).

## Held back (owner decision needed; not lanes)
- German "Sie" in `screens.commerceportal.terms.agreeExplanation`: two existing tests assert it, one records the owner decision of 2026-10-06.
- Push body: the real client (`registration.ts:108`) already matches the gateway; the mismatch is in the fixture gateway and `g1-test-provider.ts`.
Evidence for both: `plan.md`.

## Log
### 2026-11-11T12:40Z · kiro-exafyltd-202611072144-1c88 · created → drafted
Plan written and opened as a `plan(` PR for CI sparring.

### 2026-11-11T12:56Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 5 lane(s) got a VTID and are handed to Kiro.
