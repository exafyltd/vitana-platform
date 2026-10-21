# Requirements — Finish the Spotlight desktop redesign (desktop-spotlight-finish)

Follow-up plan to `.kiro/specs/desktop-spotlight/` (VTID-05105 … VTID-05117, phases 1–7 merged). That plan's
"System-wide done" item is open: 17 routes still `legacy` in `src/design/screen-manifest.json` and 3,694 `design/*`
errors carried in `scripts/ci/pr-gate/baseline/design.json`. This plan closes both under the owner's delegation of
2026-10-16 ("you can decide yourself and move on, get the redesign of vitanaland desktop done").

Contract: `docs/design-system/SPOTLIGHT_RULES.md` (SR-01 … SR-30). Nothing in this plan changes the contract — no new
archetype, card size, token or ESLint rule.

## R1 — Raw palette colours (decision 1)
1.1 Every raw Tailwind palette class, `bg-white`/`text-black`, arbitrary hex and `style` colour literal in a
non-chrome file under `src/pages/**` and `src/components/**` is replaced by the nearest existing token
(SPOTLIGHT_RULES §E, extended in design.md §2). No new tokens; `src/index.css` and `tailwind.config.ts` unchanged.
1.2 Small colour shifts are accepted (owner option A, 2026-10-14). Each PR lists its shifts by category for Gate 2.
1.3 A colour that no token can carry without inverting contrast in one theme (media scrims, white text on photos or
video, third-party brand marks) keeps its literal with `// design-allow-next-line: <reason>` (design.md §2.3).
1.4 Light and dark mode both resolve through tokens; no `dark:` palette pairs remain.

## R2 — Arbitrary sizes (decision 2)
2.1 No new size tokens.
2.2 A value with an identical Tailwind class (`h-[40px]` → `h-10`, `h-[100vh]` → `h-screen`, `w-[100%]` → `w-full`,
`max-w-[448px]` → `max-w-md`) is replaced by it.
2.3 A px/rem value within 2 px of a scale class is replaced by the nearest class.
2.4 Everything else (viewport units, `calc()`, `%`, `ch`, px values > 2 px from the scale) keeps the arbitrary value with
the documented escape hatch and a reason.

## R3 — Page spinners → skeletons (decision 3)
3.1 (Owner approved 2026-10-16.) Of the 27 page spinners in 24 page files, the 22 data-loading spinners show a
skeleton on desktop Spotlight **and** on mobile.
3.2 The skeleton is shaped like the page's loaded layout: `ArchetypeSkeleton` for a page-level wait, `VCardSkeleton`
rows for an in-section wait, inside the same `ScreenFrame`, so nothing moves when data arrives (CLS < 0.1, SR-21).
3.3 On mobile the same `ArchetypeSkeleton` / `VCardSkeleton` is shaped like the page's final mobile layout; the app
bar and bottom nav stay; content cross-fades in (none under `prefers-reduced-motion`) with no layout shift.
3.4 One shared component (`SpotlightLoading`) in `src/components/layout/spotlight/skeletons/`, no bespoke per-page
skeletons.
3.5 Spinner classification is derived from the code at the pinned ref (session eeb01b78 R3-F1). `CreatorOnboarded`,
`RedeemVoucher` and `TicketPurchaseSuccess` are data-load gated → skeletons (no allow-comment on a data-load path).
Only a spinner gated on a genuine user mutation (`isPending`) keeps a `design-allow-next-line` with an accurate reason:
`LiveRoomViewer` (only if action-gated) and `DeleteAccount` (only on the real delete mutation).
3.6 The owner gets an MP4 that shows spinner (before) vs skeleton (after) at 1400×900 and at 390×844.

## R4 — Remaining screens (decision 4)
4.1 `/u/:identifier` and `/me/profile` render on the `detail` archetype under Spotlight (contract §A lists "public
profile" under `detail`); `/profile/:id` is a redirect to it.
4.2 `/redeem` and `/delete-account` render on `form`; `/tickets/success` and `/tickets/demo` on `detail`.
4.3 `/shop` keeps the `immersive` archetype and renders inside the app shell on desktop Spotlight (SR-04: nothing
hides the sidebar or the ORB).
4.4 The Commerce portal renders inside the app shell for a signed-in member on the app host on desktop Spotlight;
guests and `commerce.vitanaland.com` keep the standalone portal. No new step, field, dialog or status (Commerce UX
contract); the PR carries a "UX acceptance" section.
4.5 Pure redirect routes (`RedirectPreservingSearch`, `LegacyProfileRedirect`, `RetiredTenantRedirect`,
`CommerceConnectionRedirect`, `InviteLanding`) leave the manifest the same way `<Navigate>` routes do.
4.6 `/business/sell-earn` stays `legacy` and unchanged: who may see it (resellers only, or everyone) is a product
question for the owner.

## R5 — Remaining contract findings
5.1 `design/no-raw-content-card` (50): member content → `VCard`; panels → `Panel` (identical shadcn DOM).
5.2 `design/no-physical-direction` (14 outside chrome): logical properties; centring (`left-1/2 -translate-x-1/2`)
and direction-bound sheets/carousels keep the escape hatch with a reason.
5.3 `design/require-screen-frame` (6): each page composes its chrome through `ScreenFrame` (via `FrameWhen` where the
page must stay unframed on phones).

## R6 — System-wide done
6.1 Manifest: every route `migrated` except `/business/sell-earn`.
6.2 `design.json`: every non-chrome entry 0 (escape-hatch lines are not counted). The six sidebar/ORB chrome files
keep their entries (SR-01).
6.3 Phones: no layout change; colour shifts per R1.2 only.
6.4 Each lane: Vitest, build, lint, PR-GATE design ratchet and Lane scope green; a read-only staging spec listed in
`docs/validation/<VTID>/staging-tests.json`; STAGING-VERIFY green before Gate 2.

## Out of scope (open owner items)
- Turning `desktop_spotlight` on in production (unchanged; owner/production decision).
- `/business/sell-earn` visibility for non-resellers (R4.6).
- I18N-PROPAGATE stale-write bug (handover item 4) — its own plan.
- The three failing STAGING-VERIFY suites on c2df019 (`/health/*`, `/autopilot` + `/business*`, Professional/Staff
  placeholders) belong to VTID-05111/05117 of the earlier plan (branch `kiro/desktop-spotlight/staging-fix-forward`).
- An admin-role test account for staging.
- Removing the legacy (Spotlight-off) code paths — a separate sparred plan.
