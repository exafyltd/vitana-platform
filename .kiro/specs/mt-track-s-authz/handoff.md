---
slug: mt-track-s-authz
author: kiro
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-01T20:20Z
---
# Handoff — mt-track-s-authz
Track S slice of the multi-tenant programme (`docs/MULTI-TENANT-PLAN.md` §3), from the Integrated Architecture
assessment. Server-side authorization for the `/api/v1/approvals` actions, the ORB work surfaces and the text-path
role. Plan: `plan.md`. Tasks: `tasks.md`. Lanes: `approvals-auth`, `work-surface-permission` (no dependency between
them). Sequenced before `mt-packs-r2` lane `persona-pack`, which shares three files (plan §5).

## Follow-ups
- F1 (sparring R1-F3, deferred): put `requireServiceOrAdmin` on the approvals GET routes (`/count`, `/pending`,
  `/feed`) together with the auth header in `frontend/command-hub/operator-console.js` (`:3116`, `:3702`) and its
  cache-busting bump. Its own Track S plan.

## Log

### 2026-11-01T20:10Z · kiro-202611011939-b712 · drafted
Owner instruction 2026-11-01 (this session): add the Integrated Architecture plan to the ongoing multi-tenant build so
both sessions work as one. The authorization gaps go first, as a Track S slice registered in the multi-tenant
programme. The planner session carries no seat because the account was not readable from the session. Lane seats come
from `docs/programs/areas.yaml` (`platform` → `exafy`). Pushed as a `plan(` PR.

### 2026-11-01T20:20Z · kiro-202611011939-b712 · drafted (round 1 answered)
Session `51e287cf` round 1: three major, two minor findings, no blocker. R1-F1, R1-F2 and R1-F4 accepted (plan §2 and
§4 now name `prItem.branch`, the resolution values with the new `permitted` member, and the non-throwing
`fetchPermittedRoles` contract with a guarded call site); R1-F3 deferred to follow-up F1 above; R1-F5 rejected with the
pinned lines quoted. Answers in `sparring/responses-1.md`. Correction: the drafted entry above carries 20:10Z; the
commit was made at 19:53Z.
