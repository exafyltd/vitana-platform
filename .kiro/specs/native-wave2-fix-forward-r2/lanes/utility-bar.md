---
lane: utility-bar
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
  - apps/mobile/src/shell/utility/**
  - apps/mobile/src/shell/OverlayHost.tsx
  - apps/mobile/src/ports/utility.tsx
  - apps/mobile/src/screens/home/HomeScreen.tsx
  - apps/mobile/src/screens/diary/DailyDiaryScreen.tsx
  - apps/mobile/src/screens/discover/UtilityBar.tsx
  - apps/mobile/src/screens/discover/VoucherModal.tsx
  - apps/mobile/src/screens/discover/LifeCompassPopup.tsx
  - apps/mobile/src/screens/discover/data/utility.ts
  - apps/mobile/src/screens/discover/data/life-compass.ts
  - apps/mobile/src/screens/marketplace-orders/UtilityBar.tsx
  - apps/mobile/src/screens/marketplace-orders/VoucherModal.tsx
  - apps/mobile/src/screens/marketplace-orders/data/chrome.ts
  - apps/mobile/src/screens/journey/UtilityBar.tsx
  - apps/mobile/src/screens/journey/VoucherModal.tsx
  - apps/mobile/src/screens/journey/data/supabase.ts
  - apps/mobile/tests/utility-bar/**
  - apps/mobile/tests/home/**
  - apps/mobile/tests/diary/diary.test.tsx
  - apps/mobile/tests/discover-commerce/voucher.test.tsx
  - apps/mobile/tests/journey/voucher.test.tsx
  - docs/validation/**
updated: 2026-11-08T12:05Z
vtid: VTID-05653
---
# Utility bar — one shared bar, voucher modal and Life Compass popup; Home and Diary backfill; copies removed
Plan: `.kiro/specs/native-wave2-fix-forward-r2/` — `plan.md` (plan block) and the `tasks.md` section marked
`<!-- lane: utility-bar -->` (tasks 1–6) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not
start before `vtid:` is set here. vitana-v1 #1573 (VTID-05510), #1575 (VTID-05511) and #1565 (VTID-05461) are merged on main; #1566
(VTID-05460) closed unmerged, so its copy does not exist and is skipped and logged.
**Measured on vitana-v1 origin/main `aac65bfeb`:** no native utility bar (`HomeScreen.tsx:16-21`, `:276`;
`DailyDiaryScreen.tsx:15-20`, `:79` render only the mode pill, web bar `Home.tsx:713-746`, `MobileDailyDiary.tsx:86-108`);
nothing listens for `vitana:open-life-compass` or `gift-voucher:open` (`OverlayHost.tsx:12-21`); three VoucherModal
copies in #1573 / #1575 / #1565 (485 / 486 / 484 lines).
**Goal.** One bar, one modal, one popup under `src/shell/utility/`, global hosts in `OverlayHost`, the bar on Home and
Diary, and no per-lane voucher copy left.
**Acceptance:** `tasks.md` lane `utility-bar` Acceptance bullets.
**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; the native app has no production profile.
## Log
### 2026-11-08T12:10Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan (re-plan of `native-wave2-fix-forward/utility-bar`, PR #4664).

### 2026-11-08T12:05Z · ci-plan-spar · ready (VTID allocated)
VTID-05653 allocated after policy approval (converged-auto-v1).
