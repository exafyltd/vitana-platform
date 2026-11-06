---
slug: native-shell-fixes
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-03T15:35Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native shell fixes
Three bugs in the native app shell (vitana-v1 `apps/mobile/`) found by reviewers of native Wave 2 lanes: two shell
reads with a doubled `/api/v1` gateway prefix (`useMyPartnerOrgs.ts:23`, `GuidedModeProvider.tsx:71`) and the
signed-out `/commerce/*` redirect (`AuthGate.tsx:46`), plus the four public commerce route mounts moved here from the
business lane (vitana-v1 #1587, VTID-05524). Plan block: `plan.md`. Lane: `lanes/shell-fixes.md` (`ready`, executor
kiro, seat exafyltd → reviewer_seat agent:vitana-lane-reviewer, no `vtid` yet). The lane waits for #1587 to merge.
## Log
### 2026-11-03T15:35Z · kiro-exafyltd-202611011658-9f52 · created → drafted
Holder of the `native-shell-fixes/_plan` claim. Plan, requirements, design, tasks and one lane written; each bug
verified on vitana-v1 origin/main `aac65bfeb` with file:line in `plan.md`. Registered in
`docs/programs/native-app/program.md`. No VTID allocated, no product code changed, no live system touched. Next:
PLAN-SPAR spars the `plan(native-shell-fixes)` PR; this session answers each round in `sparring/responses-<n>.md`.
