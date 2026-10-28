---
lane: remaining-screens
state: executing
next_actor: kiro
depends_on: [skeletons, public-profile, commerce-shell]
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: hotmail
claimed_by: kiro-202610152203-0347
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
updated: 2026-10-21T23:55Z
vtid: VTID-05292
---
# Last legacy routes + manifest 100 % (owner decision 4) (repo vitana-v1)
Plan: `.kiro/specs/desktop-spotlight-finish/` ΓÇö `plan.md` (plan block) and the `tasks.md` section marked `<!-- lane: remaining-screens -->`
(tasks R1ΓÇôR6) are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Measured on `origin/main` 5c4632ea9 (2026-10-16):** 17 files with findings in this lane's paths ΓÇö `design/no-raw-palette` 93 ┬╖ `design/no-arbitrary-size` 13 ┬╖ `design/no-physical-direction` 1 ┬╖ `design/no-raw-content-card` 5 ┬╖ `design/require-screen-frame` 3 ┬╖ `design/no-page-spinner` 3.

**Goal.** Frame `/redeem` (form), `/tickets/success` and `/tickets/demo` (detail ΓÇö one ticket/result is the spotlight card), `/delete-account` (form) and the phone-only fallbacks `MobileSettings` / `MobileSubscriptions` / `MobileDailyDiary` / `NotAuthorized` (`require-screen-frame`). Teach `scripts/design/screen-manifest.mjs` the four redirect components (`RedirectPreservingSearch`, `LegacyProfileRedirect`, `RetiredTenantRedirect`, `CommerceConnectionRedirect`) and `InviteLanding`'s redirect so pure redirects leave the manifest like `<Navigate>` does. Flip every remaining route to `migrated` except `/business/sell-earn` (open owner item). Drop `/shop` from `NO_SHELL` in the design-lint spec. The page spinners here are **data-load gated** (verified in code at the pinned ref; session eeb01b78 R3-F1): `RedeemVoucher.tsx:76` (`authLoading || voucherLoading`) and `TicketPurchaseSuccess.tsx:64` (`loading || verifying`) ΓåÆ convert to the page's `SpotlightLoading` skeleton (`form` / `detail`) in the Spotlight branch, **not** a `design-allow-next-line`. `legal/DeleteAccount.tsx`: skeletonise any data-load spinner the same way; only a spinner gated on the actual delete mutation (`isPending`) may keep an allow-comment with an accurate reason. No route is marked `migrated` while a data-load spinner remains, and no allow-reason is written that the code does not support.

**Acceptance (the reviewer seat checks these):**
- Manifest: every route `migrated` except `/business/sell-earn` (reason in `_comment`-adjacent note in the PR); `npm test` green incl. `screen-manifest.test.ts` with new cases for the redirect components.
- `design/*` = 0 in every owned file: `RedeemVoucher`/`TicketPurchaseSuccess` reach 0 by **converting** their data-load spinners to skeletons (no `design-allow-next-line` on a data-load path); `legal/DeleteAccount` reaches 0 by skeletonising any data-load spinner and may keep a `design-allow-next-line` **only** on a spinner gated on the real delete mutation (`isPending`), with a reason the code supports; baselines lowered. **Per-lane zero assertion (plan F1):** after `baseline-design`, assert every file in this lane's `paths` reads `0` or is absent in the regenerated `baseline/design.json`; the reviewer records that 0-per-owned-file result.
- Staging spec (read-only): `/redeem`, `/tickets/demo`, `/delete-account` at 1440 `?spotlight=1` show the sidebar and `data-archetype`; nothing is submitted (the delete-account confirm is never clicked; network guard aborts any non-GET).
- tasks.md "System-wide done" status line updated with the final manifest and baseline numbers.
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
(`queue.mjs claim desktop-spotlight-finish/remaining-screens --session <id>`) after `skeletons`, `public-profile`, `commerce-shell` are `done`.

### 2026-10-21T09:24Z ┬╖ ci-plan-spar ┬╖ ready (VTID allocated)
VTID-05292 allocated after policy approval (converged-auto-v1).

### 2026-10-21T22:05Z ┬╖ kiro-202610152203-0347 ┬╖ VTID reset for re-spar
The prior VTID came from session 5fbb73a2, which converged on a vitana-platform base that predated the `extra_refs`
mechanism, so the partner never read vitana-v1 (handoff log 2026-10-21T09:43Z). Cleared `vtid:` and set
`next_actor: claude`; the re-spar (vitana-v1 now declared in handoff `spar_refs:`) re-converges and CI auto-allocates a
fresh VTID bound to the new sparring record. No live system touched.
