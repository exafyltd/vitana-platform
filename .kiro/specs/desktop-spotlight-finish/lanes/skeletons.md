---
lane: skeletons
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
claimed_by: kiro-202610152203-0347
paths:
  - src/components/layout/spotlight/skeletons/**
  - src/components/layout/spotlight/index.ts
  - src/pages/BusinessHub.tsx
  - src/pages/BusinessListings.tsx
  - src/pages/BusinessOpportunities.tsx
  - src/pages/CreatorOnboarded.tsx
  - src/pages/Home.tsx
  - src/pages/IntentBoard.tsx
  - src/pages/IntentMatchDetail.tsx
  - src/pages/Messages.tsx
  - src/pages/MyIntents.tsx
  - src/pages/MyTickets.tsx
  - src/pages/PostDetail.tsx
  - src/pages/assistant/AIAssistant.tsx
  - src/pages/community/EventGamePage.tsx
  - src/pages/community/LiveRoomViewer.tsx
  - src/pages/community/MediaHub.tsx
  - src/pages/discover/Marketplace.tsx
  - src/pages/patient/Dashboard.tsx
  - src/pages/patient/Results.tsx
  - src/pages/settings/Limitations.tsx
  - src/pages/settings/SettingsNotifications.tsx
  - tests/e2e/staging/vtid-*-skeletons.staging.spec.ts
  - scripts/ci/pr-gate/baseline/design.json
  - scripts/ci/pr-gate/baseline/eslint.json
  - src/pages/RedeemVoucher.tsx
  - src/pages/TicketPurchaseSuccess.tsx
updated: 2026-10-21T23:30Z
vtid: VTID-05294
---
# Page spinners ΓåÆ archetype skeletons on desktop Spotlight and mobile (owner decision 3) (repo vitana-v1)
Plan: `.kiro/specs/desktop-spotlight-finish/` ΓÇö `plan.md` (plan block) and the `tasks.md` section marked `<!-- lane: skeletons -->`
(tasks S1ΓÇôS4) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured on `origin/main` 5c4632ea9 (2026-10-16):** 21 page files with findings in this lane's paths ΓÇö `design/no-raw-palette` 119 ┬╖ `design/no-page-spinner` 23 ┬╖ `design/no-raw-content-card` 7 ┬╖ `design/no-arbitrary-size` 11. Of the 21 pages, the data-loading spinner sites become skeletons; only `LiveRoomViewer` may keep an action spinner, and only if its reported spinner is gated on a genuine user mutation (`isPending`). `CreatorOnboarded`'s Spotlight branch is already a skeleton and its residual legacy `animate-spin` is removed/skeletonised too (session eeb01b78 R3-F1), so it is **not** a kept action spinner. `no-page-spinner` findings (23) exceed data-loading pages because some files have two spinner sites. The three action-spinner pages that Decision 4 re-archetypes ΓÇö `DeleteAccount`, `RedeemVoucher`, `TicketPurchaseSuccess` ΓÇö are **not** in this lane; they belong to `remaining-screens` (plan Decision 6 / F2).

**Goal (owner approved 2026-10-16: desktop and mobile).** Add the shared `SpotlightLoading` component and replace the 19 data-loading page spinners in the pages this lane owns with skeletons on desktop (Spotlight) **and** on mobile. Desktop: `ArchetypeSkeleton` (page-level) or `VCardSkeleton` rows (in-section) inside the page's own `ScreenFrame`. Mobile: the same `ArchetypeSkeleton` / `VCardSkeleton` shaped like the page's final mobile layout; the app bar and bottom nav stay. Content cross-fades in, no layout shift. Spinner classification is derived from the code at the pinned ref (session eeb01b78 R3-F1), not asserted. `CreatorOnboarded.tsx` already renders `ArchetypeSkeleton archetype="form"` in its Spotlight branch (`:40`, VTID-05117); its residual `animate-spin` at `:123` is on the flag-off/legacy path, and because `no-page-spinner` flags the file statically regardless of branch, that legacy spinner site must be removed or skeletonised so the file reaches 0 **without** an allow-comment. For `community/LiveRoomViewer`, keep a `// design-allow-next-line` **only** if the reported spinner is gated on a genuine user action (a mutation `isPending`), with a reason that matches the code; if it is data-load gated, convert it to a skeleton instead. Also clears every other `design/*` finding in these files.

**Acceptance (the reviewer seat checks these):**
- `design/*` = 0 in every owned page (no `Loader2`/`animate-spin` outside a button in `src/pages/**`; a `design-allow-next-line` is used **only** where the spinner is genuinely action-gated with a reason the code supports ΓÇö CreatorOnboarded's legacy spinner is removed/skeletonised, not allow-commented); design + ESLint baselines lowered for these files only. **Per-lane zero assertion (plan F1):** after `baseline-design`, assert every file in this lane's `paths` reads `0` or is absent in the regenerated `baseline/design.json` (not just "ratchet passed"); the reviewer records that 0-per-owned-file result.
- Vitest `src/components/layout/spotlight/skeletons/SpotlightLoading.test.tsx`: desktop Spotlight ΓåÆ `[data-archetype-skeleton]` / row skeletons; mobile ΓåÆ the same skeleton in the mobile shape; both with `aria-busy`, no spinner; reduced motion ΓåÆ no cross-fade.
- No layout shift: the skeleton reserves the loaded layout's boxes; the staging spec measures CLS < 0.1 on `/messages` and `/my-tickets` at **both 1400├ù900 (`?spotlight=1`) and 390├ù844**, and asserts the skeleton (no page spinner) at both viewports, with app bar and bottom nav visible at 390.
- MP4 for the owner: `docs/validation/<VTID>/spinner-vs-skeleton.mp4` (Γëñ 5 MB), before (main) and after (branch), at 1400├ù900 with `?spotlight=1` and at 390├ù844 (skeleton after on both). Recorded on a local dev build or the PR preview, read-only.
- `npx vitest run`, `npm run build`, `npm run lint` green; PR-GATE design ratchet and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's spec) and
  `plan-sparring.md` (copy of the plan's sparring record).

**Shared files.** `scripts/ci/pr-gate/baseline/design.json` and `eslint.json` are the only paths every lane lists
(each lane lowers its own entries; on a merge conflict rebase and regenerate with `gate.mjs baseline-design|baseline-eslint`).

**Never** (collaboration ┬º7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only. Sidebar/ORB chrome is out of scope (SR-01).

## Log
### 2026-10-16T09:56Z ┬╖ kiro-202610152203-0347 ┬╖ created ΓåÆ ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). Paths computed from the ESLint run on 5c4632ea9 so that no
file belongs to two lanes. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim desktop-spotlight-finish/skeletons --session <id>`).
### 2026-10-16T10:30Z ┬╖ kiro-202610152203-0347 ┬╖ scope updated (owner approved 2026-10-16)
Owner approved the skeleton switch after asking to see the mobile version: skeletons on desktop and mobile for the
22 data-loading spinners (21 here, 1 in `public-profile`); the 5 action spinners keep a spinner with a reason.

### 2026-10-21T09:24Z ┬╖ ci-plan-spar ┬╖ ready (VTID allocated)
VTID-05294 allocated after policy approval (converged-auto-v1).

### 2026-10-21T22:05Z ┬╖ kiro-202610152203-0347 ┬╖ VTID reset for re-spar
The prior VTID came from session 5fbb73a2, which converged on a vitana-platform base that predated the `extra_refs`
mechanism, so the partner never read vitana-v1 (handoff log 2026-10-21T09:43Z). Cleared `vtid:` and set
`next_actor: claude`; the re-spar (vitana-v1 now declared in handoff `spar_refs:`) re-converges and CI auto-allocates a
fresh VTID bound to the new sparring record. No live system touched.
