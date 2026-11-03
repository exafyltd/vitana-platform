---
lane: screen-backfill
state: ready
next_actor: kiro
depends_on: [orb-guided-topic]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/src/screens/journey/seams.ts
  - apps/mobile/src/screens/support/ConnectorsScreen.tsx
  - apps/mobile/app/(app)/discover/ai-picks.tsx
  - apps/mobile/src/screens/ai-picks/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/discover-commerce/ai-picks-cold-start.test.tsx
  - apps/mobile/tests/screen-backfill/**
  - docs/validation/**
updated: 2026-11-03T16:20Z
---
# Screen backfill — journey ORB bridge, Connectors AI-key sheet, `/discover/ai-picks` screen
Plan: `.kiro/specs/native-wave2-fix-forward/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: screen-backfill -->` (tasks 1–5) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here. Starts after lane `orb-guided-topic` is `done`. Do not open the PR before vitana-v1
#1565 (VTID-05461) + #1566 (VTID-05460), #1584 (VTID-05521) and #1573 (VTID-05510) have merged; a PR that closes
unmerged drops only its task (tasks.md task 4).
**Measured on vitana-v1 origin/main `aac65bfeb`:** `src/screens/support/ConnectorsScreen.tsx:181-183` shows the
placeholder for ChatGPT and Claude (web `MobileConnectedAppsView.tsx:261-264` opens the key modal); no native
`/discover/ai-picks` route (web `src/App.tsx:1034-1038`; #1573 aliases it in `resolve.ts:52-55`). On #1565 the journey
ORB bridge is a no-op (`screens/journey/seams.ts:18-20`, `:49-63`).
**Goal.** Wire journey's bridge to the ORB lane's `focusGuidedTopic` and teaching-end event, open #1584's
`AIAssistantConnectSheet` from Connectors, and port the AI picks phone layout as its own route. Hot file:
`resolve.ts` (only this lane in the plan edits it).
**Acceptance:** `tasks.md` lane `screen-backfill` Acceptance bullets.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; the native app has no production profile.
## Log
### 2026-11-03T16:20Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan.
