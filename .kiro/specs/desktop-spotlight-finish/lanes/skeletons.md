---
lane: skeletons
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
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
updated: 2026-10-21T09:24Z
vtid: VTID-05294
---
# Page spinners → archetype skeletons on desktop Spotlight and mobile (owner decision 3) (repo vitana-v1)
Plan: `.kiro/specs/desktop-spotlight-finish/` — `plan.md` (plan block) and the `tasks.md` section marked `<!-- lane: skeletons -->`
(tasks S1–S4) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured on `origin/main` 5c4632ea9 (2026-10-16):** 20 files with findings in this lane's paths — `design/no-raw-palette` 119 · `design/no-page-spinner` 23 · `design/no-raw-content-card` 7 · `design/no-arbitrary-size` 11.

**Goal (owner approved 2026-10-16: desktop and mobile).** Add the shared `SpotlightLoading` component and replace the 21 data-loading page spinners in the pages this lane owns with skeletons on desktop (Spotlight) **and** on mobile. Desktop: `ArchetypeSkeleton` (page-level) or `VCardSkeleton` rows (in-section) inside the page's own `ScreenFrame`. Mobile: the same `ArchetypeSkeleton` / `VCardSkeleton` shaped like the page's final mobile layout; the app bar and bottom nav stay. Content cross-fades in, no layout shift. The 2 action-in-progress spinners in this lane (`community/LiveRoomViewer`, `CreatorOnboarded`) keep a spinner with `// design-allow-next-line: action in progress, not a data load`. Also clears every other `design/*` finding in these files.

**Acceptance (the reviewer seat checks these):**
- `design/*` = 0 in every owned page (no `Loader2`/`animate-spin` outside a button in `src/pages/**` except the 2 action spinners with their reason); design + ESLint baselines lowered for these files only.
- Vitest `src/components/layout/spotlight/skeletons/SpotlightLoading.test.tsx`: desktop Spotlight → `[data-archetype-skeleton]` / row skeletons; mobile → the same skeleton in the mobile shape; both with `aria-busy`, no spinner; reduced motion → no cross-fade.
- No layout shift: the skeleton reserves the loaded layout's boxes; the staging spec measures CLS < 0.1 on `/messages` and `/my-tickets` at **both 1400×900 (`?spotlight=1`) and 390×844**, and asserts the skeleton (no page spinner) at both viewports, with app bar and bottom nav visible at 390.
- MP4 for the owner: `docs/validation/<VTID>/spinner-vs-skeleton.mp4` (≤ 5 MB), before (main) and after (branch), at 1400×900 with `?spotlight=1` and at 390×844 (skeleton after on both). Recorded on a local dev build or the PR preview, read-only.
- `npx vitest run`, `npm run build`, `npm run lint` green; PR-GATE design ratchet and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's spec) and
  `plan-sparring.md` (copy of the plan's sparring record).

**Shared files.** `scripts/ci/pr-gate/baseline/design.json` and `eslint.json` are the only paths every lane lists
(each lane lowers its own entries; on a merge conflict rebase and regenerate with `gate.mjs baseline-design|baseline-eslint`).

**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only. Sidebar/ORB chrome is out of scope (SR-01).

## Log
### 2026-10-16T09:56Z · kiro-202610152203-0347 · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). Paths computed from the ESLint run on 5c4632ea9 so that no
file belongs to two lanes. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim desktop-spotlight-finish/skeletons --session <id>`).
### 2026-10-16T10:30Z · kiro-202610152203-0347 · scope updated (owner approved 2026-10-16)
Owner approved the skeleton switch after asking to see the mobile version: skeletons on desktop and mobile for the
22 data-loading spinners (21 here, 1 in `public-profile`); the 5 action spinners keep a spinner with a reason.

### 2026-10-21T09:24Z · ci-plan-spar · ready (VTID allocated)
VTID-05294 allocated after policy approval (converged-auto-v1).
