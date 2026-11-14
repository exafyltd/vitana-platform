---
lane: screen-backfill
state: ready
next_actor: kiro
depends_on: [my-groups-deeplink]
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/src/screens/journey/seams.ts
  - apps/mobile/src/screens/support/ConnectorsScreen.tsx
  - apps/mobile/app/(app)/discover/ai-picks.tsx
  - apps/mobile/src/screens/ai-picks/**
  - apps/mobile/src/navigation/resolve.ts
  - apps/mobile/tests/discover-commerce/ai-picks-cold-start.test.tsx
  - apps/mobile/tests/discover-commerce/discover.test.tsx
  - apps/mobile/parity/ledger.json
  - apps/mobile/tests/screen-backfill/**
  - docs/validation/**
updated: 2026-11-11T12:56Z
vtid: VTID-05727
---
# Screen backfill — journey ORB bridge, Connectors AI-key sheet, `/discover/ai-picks` screen
Plan: `.kiro/specs/native-followups-20261111/` — `plan.md` and the `tasks.md` section marked `<!-- lane: screen-backfill -->` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Goal.** Supersedes lane `native-wave2-fix-forward-r2/screen-backfill` (VTID-05651). **Start condition: vitana-v1 PR #1639 is merged** (do not claim before). Wire the journey bridge to the ORB's `focusGuidedTopic` and teaching-end event, open `AIAssistantConnectSheet` from Connectors, port the AI picks phone layout as its own route. Two owner-approved path additions: one assertion in `discover.test.tsx:71` and one `native_only` entry in `ledger.json`.

**Acceptance:** the `tasks.md` lane `screen-backfill` Acceptance bullets. Checks: tasks 0-7 of the `screen-backfill` section of `tasks.md`.

**Never.** `resolve.ts` is edited after `my-groups-deeplink` has merged (hot file); `ledger.json` gains one `native_only` entry and no row change. No VTID by hand, no merge or approve, no workflow dispatch or deploy, no write to Supabase, AWS or any live system, no test against production; the native app has no production profile.

## Log
### 2026-11-11T12:40Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-11T12:56Z · ci-plan-spar · ready (VTID allocated)
VTID-05727 allocated after policy approval (converged-auto-v1).
