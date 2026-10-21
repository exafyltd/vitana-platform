---
slug: i18n-audit-nightly-off
author: kiro
executor: claude
next_actor: claude
state: drafted
updated: 2026-10-21T08:40Z
---
# Handoff — i18n-audit-nightly-off
The nightly i18n audit runs on an out-of-quota Gemini key, shows green anyway, never reaches `main` and leaves 9
branches a night. This removes the schedule, keeps the manual audit and defaults it to `deepseek`.
Plan: `plan.md`. Requirements, design and tasks are alongside.
Lanes:
- `workflow-off`: executor **claude** (governance paths `.github/**`, `CLAUDE.md`), reviewer `exafy`.
## Log
### 2026-10-19T17:40Z · kiro-202610181950-f0b7 · drafted
Written on the owner's instruction ("ok, execute") after the analysis in this session. Evidence comes from scheduled run
39227796755 and `git log origin/main`. Implementation is prepared as a draft PR on
`kiro/i18n-audit-nightly-off/workflow-off`. Next: PLAN-SPAR spars this PR, then Claude Code / the Project Manager
takes the lane.
### 2026-10-20T08:00Z · kiro-202610181950-f0b7 · drafted
Moved from exafyltd/vitana-v1#1462 (closed) to vitana-platform, because PLAN-SPAR only runs in vitana-platform. The
lane's code stays in vitana-v1 (draft PR exafyltd/vitana-v1#1463). That repo's Lane scope check already falls back to
vitana-platform for the lane file.
### 2026-10-21T08:40Z · kiro-202610181950-f0b7 · drafted (round 1 answered)
All three round-1 findings accepted (`sparring/responses-1.md`): draft exafyltd/vitana-v1#1463 closed unmerged
(code follows the VTID); the script's own default provider and the dead `pull-requests: write` permission are added
to the plan. The lane file is unchanged (only its claim holder edits it): the executor adds scripts/i18n-audit-llm.mjs to paths when it moves the lane to executing.
