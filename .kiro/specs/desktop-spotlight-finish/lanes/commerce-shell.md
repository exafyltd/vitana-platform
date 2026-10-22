---
lane: commerce-shell
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
claimed_by: kiro-202610152203-0347
paths:
  - src/components/commerce/**
  - src/pages/Commerce*.tsx
  - src/pages/ShopFeed.tsx
  - src/pages/UniversalCart.tsx
  - src/pages/portals/CommercePortalLogin.tsx
  - src/i18n/*/spotlightCommerce.json
  - tests/e2e/staging/vtid-*-commerce-shell.staging.spec.ts
  - scripts/ci/pr-gate/baseline/design.json
  - scripts/ci/pr-gate/baseline/eslint.json
  - docs/SCREEN_INVENTORY.md
updated: 2026-10-21T23:30Z
vtid: VTID-05290
---
# `/shop` and the Commerce portal inside the app shell on desktop Spotlight (owner decision 4, Commerce UX contract) (repo vitana-v1)
Plan: `.kiro/specs/desktop-spotlight-finish/` ΓÇö `plan.md` (plan block) and the `tasks.md` section marked `<!-- lane: commerce-shell -->`
(tasks C1ΓÇôC4) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured on `origin/main` 5c4632ea9 (2026-10-16):** 28 files with findings in this lane's paths ΓÇö `design/no-raw-palette` 175 ┬╖ `design/no-arbitrary-size` 6 ┬╖ `design/no-raw-content-card` 1.

**Goal.** SR-04 says nothing hides the sidebar or the ORB. With Spotlight on, `/shop` renders inside `AppLayout` with the `immersive` frame (in-screen chrome hidden, sidebar + ORB stay). `CommerceShell` gets a third case: signed-in member on the app host (not `commerce.vitanaland.com`) on desktop with Spotlight on ΓåÆ the same `AppLayout` skin the phone app already uses (VTID-03999 rationale: business people are members). Guests and `commerce.vitanaland.com` keep the standalone portal. No step, field, dialog or status is added. Clears every `design/*` finding in the owned files.

**Acceptance (the reviewer seat checks these):**
- PR body has the **UX acceptance** section (CLAUDE.md Commerce UX contract): user steps ┬╖ required fields ┬╖ decisions ┬╖ inferable asks = none ┬╖ next step always clear ┬╖ friction unchanged.
- `design/*` = 0 in every owned file; baselines lowered.
- Vitest: `CommerceShell` picks AppLayout for (desktop, Spotlight on, member, app host), standalone otherwise (4 cases); `ShopFeed` under Spotlight renders inside AppLayout.
- Staging spec (read-only): signed in, 1440 `?spotlight=1`: `/shop` and `/commerce` show the sidebar; signed out `/commerce` shows the guest landing without it.
- `npx vitest run`, `npm run build`, `npm run lint` green; PR-GATE design ratchet and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's spec) and
  `plan-sparring.md` (copy of the plan's sparring record).

**Shared files.** `scripts/ci/pr-gate/baseline/design.json` and `eslint.json` are the only paths every lane lists (plus `docs/SCREEN_INVENTORY.md`, shared by the three lanes that add copy: regenerate with `npm run i18n:inventory`)
(each lane lowers its own entries; on a merge conflict rebase and regenerate with `gate.mjs baseline-design|baseline-eslint`).

**Never** (collaboration ┬º7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only. Sidebar/ORB chrome is out of scope (SR-01).

## Log
### 2026-10-16T09:56Z ┬╖ kiro-202610152203-0347 ┬╖ created ΓåÆ ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). Paths computed from the ESLint run on 5c4632ea9 so that no
file belongs to two lanes. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim desktop-spotlight-finish/commerce-shell --session <id>`).

### 2026-10-21T09:24Z ┬╖ ci-plan-spar ┬╖ ready (VTID allocated)
VTID-05290 allocated after policy approval (converged-auto-v1).

### 2026-10-21T22:05Z ┬╖ kiro-202610152203-0347 ┬╖ VTID reset for re-spar
The prior VTID came from session 5fbb73a2, which converged on a vitana-platform base that predated the `extra_refs`
mechanism, so the partner never read vitana-v1 (handoff log 2026-10-21T09:43Z). Cleared `vtid:` and set
`next_actor: claude`; the re-spar (vitana-v1 now declared in handoff `spar_refs:`) re-converges and CI auto-allocates a
fresh VTID bound to the new sparring record. No live system touched.
