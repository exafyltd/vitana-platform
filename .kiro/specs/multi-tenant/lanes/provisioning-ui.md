---
lane: provisioning-ui
state: ready
next_actor: kiro
vtid: VTID-05221
seat: hotmail
area: frontend
depends_on: []
updated: 2026-10-15T16:30Z
---
# Exafy-admin "New community" panel — VTID-05221 (repo vitana-v1)

Plan: `.kiro/specs/multi-tenant/plan-sparring.md` (authoritative) and the `provisioning-ui` section of `tasks.md`
(tasks P1–P9, allowed paths, acceptance). Design and the rules you must follow: `design.md`.
VTID-05221 is allocated and `in_progress`/`approved` in the ledger.

Rules for the executor (collaboration §7a): no VTID allocation, no `_plan` claim, no edit of `handoff.md`, no
merge/approve/deploy/workflow dispatch, no Supabase or AWS writes, and never call a provisioning write endpoint against
any live system. Work only inside the allowed paths. Copy `plan-sparring.md` to
`vitana-v1/docs/validation/VTID-05221/plan-sparring.md` and add `scope.json` and `staging-tests.json` there.
Branch `kiro/multi-tenant/provisioning-ui`; PR title `VTID-05221 (multi-tenant/provisioning-ui): …`; commit trailers
`Collab-Session: <your kiro session id>` and `Collab-Lane: multi-tenant/provisioning-ui`. When the PR is open: set
`state: in-review`, `next_actor: claude`, `pr: <url>`, append a log entry, release the claim.

## Log
### 2026-10-15T16:30Z · session_01TMPMNGNEtPxKwmVqyfdx46 · created → ready
Owner approved the plan at Gate 1 (2026-10-15); VTID-05221 allocated. Handed to Kiro: `next_actor: kiro`, seat
`hotmail` (Kiro IDE, dstevanovic@hotmail.com) because the owner asked for that account for this hand-off test — the area
map alone would give `frontend` lanes to `exafyltd`. Start by claiming the lane
(`node scripts/collab/queue.mjs claim multi-tenant/provisioning-ui --session <your id> --repo <vitana-platform>`).
