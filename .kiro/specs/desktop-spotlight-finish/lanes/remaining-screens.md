---
lane: remaining-screens
state: ready
next_actor: claude
depends_on: [skeletons, public-profile, commerce-shell]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
paths:
  - src/pages/MobileDailyDiary.tsx
  - src/pages/MobileSettings.tsx
  - src/pages/MobileSubscriptions.tsx
  - src/pages/NotAuthorized.tsx
  - src/pages/RedeemVoucher.tsx
  - src/pages/TicketDemo.tsx
  - src/pages/TicketPurchaseSuccess.tsx
  - src/pages/legal/DeleteAccount.tsx
  - src/pages/InviteLanding.tsx
  - src/components/tickets/**
  - src/components/voucher/**
  - scripts/design/screen-manifest.mjs
  - src/design/screen-manifest.json
  - src/design/screen-manifest.test.ts
  - tests/e2e/staging/design-contract.staging.spec.ts
  - src/i18n/*/spotlightRemaining.json
  - tests/e2e/staging/vtid-*-remaining-screens.staging.spec.ts
  - scripts/ci/pr-gate/baseline/design.json
  - scripts/ci/pr-gate/baseline/eslint.json
  - docs/SCREEN_INVENTORY.md
updated: 2026-10-21T22:05Z
---
# Last legacy routes + manifest 100 % (owner decision 4) (repo vitana-v1)
Plan: `.kiro/specs/desktop-spotlight-finish/` — `plan.md` (plan block) and the `tasks.md` section marked `<!-- lane: remaining-screens -->`
(tasks R1–R6) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured on `origin/main` 5c4632ea9 (2026-10-16):** 17 files with findings in this lane's paths — `design/no-raw-palette` 93 · `design/no-arbitrary-size` 13 · `design/no-physical-direction` 1 · `design/no-raw-content-card` 5 · `design/require-screen-frame` 3 · `design/no-page-spinner` 3.

**Goal.** Frame `/redeem` (form), `/tickets/success` and `/tickets/demo` (detail — one ticket/result is the spotlight card), `/delete-account` (form) and the phone-only fallbacks `MobileSettings` / `MobileSubscriptions` / `MobileDailyDiary` / `NotAuthorized` (`require-screen-frame`). Teach `scripts/design/screen-manifest.mjs` the four redirect components (`RedirectPreservingSearch`, `LegacyProfileRedirect`, `RetiredTenantRedirect`, `CommerceConnectionRedirect`) and `InviteLanding`'s redirect so pure redirects leave the manifest like `<Navigate>` does. Flip every remaining route to `migrated` except `/business/sell-earn` (open owner item). Drop `/shop` from `NO_SHELL` in the design-lint spec. The 3 page spinners here (`RedeemVoucher`, `TicketPurchaseSuccess`, `legal/DeleteAccount`) are action-in-progress and keep a spinner, each with `// design-allow-next-line: action in progress, not a data load` (owner approved 2026-10-16).

**Acceptance (the reviewer seat checks these):**
- Manifest: every route `migrated` except `/business/sell-earn` (reason in `_comment`-adjacent note in the PR); `npm test` green incl. `screen-manifest.test.ts` with new cases for the redirect components.
- `design/*` = 0 in every owned file (the 3 action spinners `RedeemVoucher`/`TicketPurchaseSuccess`/`legal/DeleteAccount` keep their `design-allow-next-line` reason, so they are not counted and still read 0); baselines lowered. **Per-lane zero assertion (plan F1):** after `baseline-design`, assert every file in this lane's `paths` reads `0` or is absent in the regenerated `baseline/design.json`; the reviewer records that 0-per-owned-file result.
- Staging spec (read-only): `/redeem`, `/tickets/demo`, `/delete-account` at 1440 `?spotlight=1` show the sidebar and `data-archetype`; nothing is submitted (the delete-account confirm is never clicked; network guard aborts any non-GET).
- tasks.md "System-wide done" status line updated with the final manifest and baseline numbers.
- `npx vitest run`, `npm run build`, `npm run lint` green; PR-GATE design ratchet and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (this lane's spec) and
  `plan-sparring.md` (copy of the plan's sparring record).

**Shared files.** `scripts/ci/pr-gate/baseline/design.json` and `eslint.json` are the only paths every lane lists (plus `docs/SCREEN_INVENTORY.md`, shared by the three lanes that add copy: regenerate with `npm run i18n:inventory`)
(each lane lowers its own entries; on a merge conflict rebase and regenerate with `gate.mjs baseline-design|baseline-eslint`).

**Never** (collaboration §7a): no VTID allocation, no merge/approve, no workflow dispatch or deploy, no writes to
Supabase/AWS, no test against production; staging specs are read-only. Sidebar/ORB chrome is out of scope (SR-01).

## Log
### 2026-10-16T09:56Z · kiro-202610152203-0347 · created → ready
Lane drafted with the plan (`state: drafted` in `handoff.md`). Paths computed from the ESLint run on 5c4632ea9 so that no
file belongs to two lanes. Next: PLAN-SPAR spars the plan; once a VTID is written here, seat `exafyltd` claims the lane
(`queue.mjs claim desktop-spotlight-finish/remaining-screens --session <id>`) after `skeletons`, `public-profile`, `commerce-shell` are `done`.

### 2026-10-21T09:24Z · ci-plan-spar · ready (VTID allocated)
VTID-05292 allocated after policy approval (converged-auto-v1).

### 2026-10-21T22:05Z · kiro-202610152203-0347 · VTID reset for re-spar
The prior VTID came from session 5fbb73a2, which converged on a vitana-platform base that predated the `extra_refs`
mechanism, so the partner never read vitana-v1 (handoff log 2026-10-21T09:43Z). Cleared `vtid:` and set
`next_actor: claude`; the re-spar (vitana-v1 now declared in handoff `spar_refs:`) re-converges and CI auto-allocates a
fresh VTID bound to the new sparring record. No live system touched.
