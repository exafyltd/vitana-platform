---
lane: colours-batch-4
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - src/components/discover/**
  - src/components/wallet/**
  - src/components/payment/**
  - src/components/calendar/**
  - src/components/business/**
  - src/components/reseller/**
  - src/components/orders/**
  - src/components/subscription/**
  - src/components/intents/**
  - src/pages/Calendar.tsx
  - src/pages/Discover.tsx
  - src/pages/discover/AIPicksPage.tsx
  - src/pages/discover/CategoryProducts.tsx
  - src/pages/discover/DealsOffers.tsx
  - src/pages/discover/DoctorsCoaches.tsx
  - src/pages/discover/Orders.tsx
  - src/pages/discover/ProductDetail.tsx
  - src/pages/discover/ProviderProfile.tsx
  - src/pages/discover/Supplements.tsx
  - src/pages/discover/WellnessServices.tsx
  - src/pages/wallet/Balance.tsx
  - src/pages/wallet/Rewards.tsx
  - src/pages/wallet/Subscriptions.tsx
  - tests/e2e/staging/vtid-*-colours-batch-4.staging.spec.ts
  - scripts/ci/pr-gate/baseline/design.json
  - scripts/ci/pr-gate/baseline/eslint.json
updated: 2026-10-21T09:24Z
vtid: VTID-05288
---
# Raw palette → tokens, batch 4 (owner decision 1, option A) (repo vitana-v1)
Plan: `.kiro/specs/desktop-spotlight-finish/` — `plan.md` (plan block) and the `tasks.md` section marked `<!-- lane: colours-batch-4 -->`
(tasks K4) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured on `origin/main` 5c4632ea9 (2026-10-16):** 96 files with findings in this lane's paths — `design/no-raw-palette` 545 · `design/no-arbitrary-size` 51 · `design/no-raw-content-card` 10.

**Goal.** Clear every `design/*` finding in the 96 files of this batch: raw palette → nearest existing token (SPOTLIGHT_RULES §E + the extended mapping in design.md §2), arbitrary sizes per decision 2, raw `Card` → `VCard`/`Panel` per design.md §4, leftover physical directions per design.md §5.

**Acceptance (the reviewer seat checks these):**
- `design/*` = 0 in every owned file (escape-hatch lines only with a reason); design + ESLint baselines lowered for these files only, every other entry byte-identical.
- No `dark:` palette pairs left; no file worse on any rule (`gate.mjs ratchet-design` green vs base); Vitest + build + lint green.
- PR body lists the colour shifts by category (status / category / surface / text / overlay / gradient) for the Gate 2 review.
- Staging spec (read-only): the batch's main routes at 1440 `?spotlight=1` and 390 render without console errors and pass the design-contract structural checks.
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
(`queue.mjs claim desktop-spotlight-finish/colours-batch-4 --session <id>`).

### 2026-10-21T09:24Z · ci-plan-spar · ready (VTID allocated)
VTID-05288 allocated after policy approval (converged-auto-v1).
