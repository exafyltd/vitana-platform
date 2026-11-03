---
lane: public-entry
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
  - apps/mobile/app/index.tsx
  - apps/mobile/src/linking/link-router.ts
  - apps/mobile/parity/ledger.json
  - apps/mobile/tests/index.test.tsx
  - apps/mobile/tests/public-entry/**
  - docs/validation/**
updated: 2026-11-03T16:20Z
---
# Public entry — the storefront at `/` and cold-start `/i/:code` invite links
Plan: `.kiro/specs/native-wave2-fix-forward/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: public-entry -->` (tasks 1–5) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here. Do not open the PR before vitana-v1 #1553 (VTID-05451, public-legal) has merged; if
it closes unmerged, ship only the link-router task and log the fallback.
**Measured on vitana-v1 origin/main `aac65bfeb`:** `app/index.tsx:12-17` sends signed-out users to `/maxina`; ledger
`/` is `native_only` (`parity/ledger.json:5-8`) and `PUBLIC.LANDING` is `not_started` (`:1841-1847`); web `/` is the
storefront (`src/App.tsx:818`). The link router only delivers an invite to the auth port (`src/linking/link-router.ts:63-65`)
and nothing on main navigates to `/i/:code`, so a cold-start invite is never read.
**Goal.** Render #1553's `PublicLandingScreen` at `/` for signed-out users and navigate every invite link to
`/i/<code>` once the navigator is attached; flip the `PUBLIC.LANDING` row. Hot file: the ledger (only this lane in the
plan edits it).
**Acceptance:** `tasks.md` lane `public-entry` Acceptance bullets.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; the native app has no production profile.
## Log
### 2026-11-03T16:20Z · kiro-exafyltd-202611011658-9f52 · ready
Lane created with the plan.
