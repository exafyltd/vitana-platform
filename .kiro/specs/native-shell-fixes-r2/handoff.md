---
slug: native-shell-fixes-r2
author: kiro
executor: kiro
next_actor: kiro
state: approved
author_seat: exafyltd
updated: 2026-11-08T12:04Z
spar_refs:
  - exafyltd/vitana-v1: main
sparring_record: .kiro/specs/native-shell-fixes-r2/sparring/verdict.md
vtids: [VTID-05647]
---
# Handoff — Native shell fixes
Three bugs in the native app shell (vitana-v1 `apps/mobile/`) found by reviewers of native Wave 2 lanes: two shell
reads with a doubled `/api/v1` gateway prefix (`useMyPartnerOrgs.ts:23`, `GuidedModeProvider.tsx:71`) and the
signed-out `/commerce/*` redirect (`AuthGate.tsx:46`), plus the four public commerce route mounts moved here from the
business lane (vitana-v1 #1587, VTID-05524). Plan block: `plan.md`. Lane: `lanes/shell-fixes.md` (`ready`, executor
kiro, seat exafyltd → reviewer_seat agent:vitana-lane-reviewer, no `vtid` yet). The lane waits for #1587 to merge.
## Log
### 2026-11-08T11:47Z · kiro-exafyltd-202611072144-1c88 · drafted
Handoff created with the plan (re-plan of `native-shell-fixes/shell-fixes`, PR #4657).

### 2026-11-08T12:04Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 1 lane(s) got a VTID and are handed to Kiro.
