---
lane: analytics
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/src/analytics/**
  - apps/mobile/src/shell/ShellRoot.tsx
  - apps/mobile/tests/analytics/**
  - docs/validation/**
updated: 2026-11-03T16:20Z
---
# Analytics — a native product analytics client and `screen_viewed`
Plan: `.kiro/specs/native-wave2-fix-forward/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: analytics -->` (tasks 1–4) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here.
**Measured on vitana-v1 origin/main `aac65bfeb`:** no analytics client in `apps/mobile/src` or `packages/core/src`.
Web: `src/lib/product-analytics/client.ts` (`POST /api/v1/analytics/events/batch`, `:37`; batching `:41-44`; event
`:240-256`, `source: "web"` `:251`) and `src/components/AnalyticsTracker.tsx:60-70` (`screen_viewed`). The gateway
accepts `source` `ios` / `android` (vitana-platform `services/gateway/src/routes/product-analytics.ts:68`).
**Goal.** Same events, shape, consent and batching as mobile web, `source` = platform, mounted once in `ShellRoot`.
No call-site events and no celebrate post (plan decision 8). No gateway change.
**Acceptance:** `tasks.md` lane `analytics` Acceptance bullets.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production (fake `fetch` only); the native app has no production profile.
## Log
### 2026-11-03T16:20Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan.
