---
change_class: standard
---
# plan(sidebar-chrome-colour-tokens): two palette-to-token colour swaps in the sidebar header and the mobile top app bar
<!-- plan:begin -->
## Goal
Owner instruction, 2026-11-01, Kiro session `kiro-ide-202610272306-27b0`. The parent session asked the owner to reply
"fix sidebar colours" to allow exactly two colour-token swaps in the sidebar / app-bar chrome. The owner answered:
*"decide yourself and get it done"*. This plan records that answer as the owner instruction for exactly the two swaps
below and nothing else.

Make the two remaining raw Tailwind palette classes in the app chrome use design tokens, so that the vitana-v1
STAGING-VERIFY suites VTID-05286, VTID-05287 and VTID-05289 stop failing on them:

| # | File:line (vitana-v1 `origin/main` @ `ec8682fec4ea06072b80c8a7ece1e729a3de4135`) | Today | After | SPOTLIGHT_RULES §E row |
|---|---|---|---|---|
| S1 | `src/components/AppLayout.tsx:186`, the exafy-admin `Shield` icon beside the tenant name in the sidebar header | `text-slate-400` | `text-muted-foreground` | `text-gray-500`, `text-slate-500`, `text-zinc-500` → `text-muted-foreground` (nearest row: same neutral family, one step lighter) |
| S2 | `src/components/mobile/TopAppBar.tsx:111`, the pulsing dot of the "LIVE" badge in the mobile top app bar | `bg-red-500` | `bg-status-error` | `text-red-500/600` (error) → `text-status-error` or `text-destructive` (the same token as a background) |

Nothing else changes: same element, same size, same `animate-pulse`, same markup, same order. Only one class token on
each line is replaced.

## Today (evidence)
- STAGING-VERIFY run https://github.com/exafyltd/vitana-platform/actions/runs/41300076673 on vitana-v1 `c5c2cab4`
  failed suites 05286, 05287 and 05289 on exactly these two classes (record:
  `vitana-platform:.agents/tasks/backlog-cleanup-2026-10-28/v1-staging-verify-2.md` §1):
  - `lucide lucide-shield h-3 w-3 text-slate-400` at 1440 on /health, /memory/recall (05286); /comm/groups,
    /comm/live-rooms, /sharing, /sharing/campaigns (05287); /settings, /settings/connected-apps, /autopilot (05289).
    It shows only for an exafy admin and only while the sidebar is open (`AppLayout.tsx:183-188`:
    `{open && (… {isExafyAdmin && <Shield className="h-3 w-3 text-slate-400" />} …)}`).
  - `h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse shrink-0` at 390 on /memory/diary (05286),
    `TopAppBar.tsx:111`, inside the `showLive` button (`:103-117`).
- The suites' check is `RAW_PALETTE_SRC` in `tests/e2e/staging/vtid-05286-colours-batch-2.staging.spec.ts:43-44`
  (same in 05287/05289): any `bg|text|border|…-(slate|gray|…|red|…)-<n>` class on a rendered element fails.
- Tokens exist, no new token is needed:
  - `tailwind.config.ts`: `muted.foreground = hsl(var(--muted-foreground))`; `status.error.DEFAULT =
    hsl(var(--status-error))` (and `destructive.DEFAULT = hsl(var(--destructive))`). So `text-muted-foreground` and
    `bg-status-error` are generated classes.
  - `src/index.css`: `--muted-foreground` is defined for light (`215.4 16.3% 46.9%`) and dark (`215 20.2% 65.1%`);
    `--status-error` for light (`0 72% 51%`) and dark (`0 91% 71%`). Both swaps therefore follow the theme in light
    and dark mode. `bg-status-error` exists, so the `destructive` alternative of the §E row is not used.
- Other raw palette classes in `AppLayout.tsx` (`:351`, `:376`, the pink `AvatarFallback` gradient in the sidebar
  footer / profile) are **out of scope**: they did not fail the suites (the avatar image renders) and the owner
  instruction covers exactly two swaps. They stay as they are.
- No test renders `AppLayout` or `TopAppBar` today (`git ls-tree origin/main -- src` has no `*AppLayout*.test*` or
  `*TopAppBar*.test*`).

## Design decisions
- **D1 Two class swaps only.** No structural, order, navigation or behaviour change to the sidebar or the app bar
  (CLAUDE.md ALWAYS 31; `.claude/rules/design.md` "never touch the sidebar … chrome" is honoured for everything except
  these two colour classes, which the owner instruction above covers). No new token, no `index.css` /
  `tailwind.config.ts` edit, no Spotlight contract (`SPOTLIGHT_RULES.md`) change, no ESLint rule or baseline edit, no
  screen-manifest, navigation-registry or parity-ledger change, no i18n string.
- **D2 Light, dark, RTL.** Both tokens have light and dark values (above). Colour classes carry no direction, and no
  layout class is touched, so RTL is unchanged by construction. The Vitest also renders both components under
  `dir="rtl"` and the screenshots include one RTL capture per component.
- **D3 `text-muted-foreground` for the icon.** The icon sits inside a span styled `text-sidebar-foreground/50`.
  `text-muted-foreground` is the §E neutral-grey token and keeps it a quiet secondary mark in both themes.
  `text-sidebar-foreground/50` (inherit) would also be token-clean, but §E names `text-muted-foreground` for this
  grey family, so the plan follows the table.
- **D4 `bg-status-error` for the live dot.** It is the semantic "error / live red" status token, named first in the
  §E row. `bg-destructive` is the documented alternative and is not needed because `status-error` exists.

## Lane
One lane, `chrome-colour-tokens`, vitana-v1, `executor: kiro`, seat `exafyltd` (area `frontend`, the catch-all in
`docs/programs/areas.yaml`; no more specific area covers `src/components/AppLayout.tsx` or
`src/components/mobile/TopAppBar.tsx`). Reviewer: `agent:vitana-lane-reviewer`. Paths:
- `src/components/AppLayout.tsx`
- `src/components/mobile/TopAppBar.tsx`
- `src/components/chrome-colour-tokens.test.tsx` (new)
- `docs/validation/VTID-*/**` (this lane's own VTID directory only)

No protected gate file, no governance path, no hot shared file. Nothing else is in flight on these two files that this
plan knows of; the lane updates from `main` before landing.

## Tests and commands (vitana-v1 worktree, Windows)
- **Red → green.** New `src/components/chrome-colour-tokens.test.tsx` (Vitest, jsdom):
  - renders `TopAppBar` in a `MemoryRouter` on a route where `showLive` is true, with `useTenant` and
    `useSoundscape` mocked; asserts no element inside the `header` has a class matching the staging suites'
    `RAW_PALETTE_SRC` pattern (copied verbatim), and that the live dot carries `bg-status-error`;
  - renders `AppLayout` (desktop, `useIsMobile` false, sidebar open) with its hook and child-component modules mocked
    and `useTenant` returning `isExafyAdmin: true`; asserts the sidebar header (`[data-sidebar="header"]`) has no raw
    palette class and that the `lucide-shield` icon carries `text-muted-foreground`;
  - repeats both renders with `dir="rtl"` on the container and expects the same.
  The scope of the AppLayout assertion is the sidebar header, because the out-of-scope avatar fallback classes
  (`:351`, `:376`) live elsewhere in the same component.
  Commit order: the test first (fails on `origin/main` on both components), then the two swaps (passes). The red run
  and the green run are logged in `docs/validation/<VTID>/commands.log`.
- `npx vitest run src/components/chrome-colour-tokens.test.tsx` and the regression net
  `npx vitest run src/components src/design`.
- `npm run lint` (ESLint `design/*` and i18n rules; the PR-GATE design ratchet compares with the base branch, and the
  raw-palette count of both files goes down by one, never up).
- `npm run test:design-contract`; `npm run design:manifest` (expect no diff).
- `node scripts/ci/pr-gate/gate.mjs weakening --base origin/main --head HEAD` (no test weakened).
- **Screenshots (local only, never production).** Local `npm run dev` (port 8080) and Playwright at 1400x900 (sidebar
  header, sidebar open) and 390x844 (mobile top app bar with the LIVE badge), each in light and dark mode, plus one
  RTL (`dir="rtl"`) capture per component. Every Supabase and gateway request is intercepted by Playwright and
  fulfilled from fixtures; any request that is not mocked is aborted, so nothing reaches a live host and nothing is
  written. If the harness cannot make the exafy-admin shield render, the PR says so, the Vitest DOM assertion is the
  local proof and STAGING-VERIFY is the visual proof. Saved under `docs/validation/<VTID>/screenshots/`.
- **Staging (proof).** `docs/validation/<VTID>/staging-tests.json` (`service: community-app`) lists three
  `kind: playwright` entries: the existing specs `tests/e2e/staging/vtid-05286-colours-batch-2.staging.spec.ts`,
  `vtid-05287-colours-batch-3.staging.spec.ts` and `vtid-05289-colours-batch-5.staging.spec.ts` (unchanged,
  read-only). Done = STAGING-VERIFY green on the lane's merge commit for these three suites.
  Deploy path: merge to `main` touching `src/**` → `AWS-STAGE-DEPLOY-FRONTEND.yml` → `preview-aws.vitanaland.com` →
  platform `STAGING-VERIFY.yml`. Suite VTID-05288 (console errors, /wallet CORS in `useEurUsdRate.ts`) is out of
  scope and tracked separately.

## Measurement
`docs/validation/<plan VTID>/timings.json` (`vitana.plan-timings/v1`), written by the closing step.

## Risks
1. Rendering `AppLayout` in jsdom needs many module mocks → the test mocks modules only (no export or prop added to
   `AppLayout`, no behaviour change). If a child cannot be mocked cleanly it is replaced by a stub component in
   `vi.mock`, never by editing the component.
2. Contrast: `text-muted-foreground` on the sidebar is the same token the rest of the sidebar's secondary text uses;
   the icon is decorative next to the tenant name. `status-error` is the existing error red in both themes.
3. A suite fails for a reason other than these classes → the failure message names the class; anything else is a
   separate finding and is not fixed in this lane.

## Unchanged
Sidebar structure, item order, navigation, Start Stream, ORB, `MobileBottomNav`, the profile/role switcher, every other
class in both files (including `AppLayout.tsx:351` and `:376`), `index.css`, `tailwind.config.ts`,
`SPOTLIGHT_RULES.md`, ESLint rules and baselines, routes and registries, i18n catalogs.
<!-- plan:end -->
