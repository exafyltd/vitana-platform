---
slug: mt-track-s-authz
author: kiro
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-01T20:10Z
---
# Handoff — mt-track-s-authz
Track S slice of the multi-tenant programme (`docs/MULTI-TENANT-PLAN.md` §3), from the Integrated Architecture
assessment. Server-side authorization for the `/api/v1/approvals` actions, the ORB work surfaces and the text-path
role. Plan: `plan.md`. Tasks: `tasks.md`. Lanes: `approvals-auth`, `work-surface-permission` (no dependency between
them). Sequenced before `mt-packs-r2` lane `persona-pack`, which shares three files (plan §5).

## Log

### 2026-11-01T20:10Z · kiro-202611011939-b712 · drafted
Owner instruction 2026-11-01 (this session): add the Integrated Architecture plan to the ongoing multi-tenant build so
both sessions work as one. The authorization gaps go first, as a Track S slice registered in the multi-tenant
programme. The planner session carries no seat because the account was not readable from the session. Lane seats come
from `docs/programs/areas.yaml` (`platform` → `exafy`). Pushed as a `plan(` PR.
