# Requirements — Native Wave 2: Public / Auth / Onboarding / Legal screen ports (native-wave2-public-auth-onboarding)
Wave 2 public/auth/onboarding/legal screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021). Port the signed-out storefront, the auth
surfaces (sign in/up, OAuth complete/consent, password reset, email/portal confirm), onboarding and legal screens that
the parity ledger assigns to the `public-auth` lane to the native app (`apps/mobile/`) at 1:1 parity with today's
**mobile web** screens (the `PublicAppShell` branch), built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit
(`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime verification on a device — and the real
OAuth browser round-trip — needs the isolated test environment G1 and is called out per task as `depends-on-owner`.
Measured on the worktree (= `origin/main`), parity ledger `apps/mobile/parity/ledger.json` version 2:
**20 rows carry `"lane": "public-auth"`** (5 `registry` screen rows + 15 `exclusion` route rows; 435 rows total) —
**2 `exception`** (`/download`, `/maxina/app`, kept as web pages), **5 `in_progress`** (`AUTH.MAXINA_PORTAL`,
`AUTH.ALKALMA_PORTAL`, `/oauth/complete`, `/reset-password`, `/logout`, whose functional core N3 landed), **13
`not_started`**. Counted with `node -e` over the committed ledger JSON (the `--report` command needs `typescript`,
which is not installed in this worktree). The three lanes below partition those 20 rows with **disjoint `paths`**.
Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §4 (parity method), §6 (verification &
safety), the N2 README web→native prop map (`apps/mobile/README.md` "Web → native prop map"), the Spotlight / design
rules via tokens, and the g1-wiring / N3 link + auth plumbing (`apps/mobile/src/linking/**`, `apps/mobile/src/auth/**`)
which is **reused, not reinvented** (R1.5). No new web screen, no `App.tsx` route, no `screens.json` / `exclusions.json`
entry is added by this plan (ports only), so no `screen-manifest` or voice-registry change and no new native parity
row — only status flips on existing rows.
## R0 — Scope and the three lanes
0.1 The plan ports exactly the web destinations the parity ledger lists under `"lane": "public-auth"` (20 rows; 18
ported, 2 kept-`exception`), split into three disjoint lanes by cluster. No row is in two lanes; no row in scope is
left without a lane.
0.2 Lane **`auth-portals`** — everything auth (10 rows): `AUTH.MAXINA_PORTAL /maxina` (web
`src/pages/portals/MaxinaPortal.tsx`, 878 lines; route `src/App.tsx:876`; `in_progress`),
`AUTH.ALKALMA_PORTAL /alkalma` (web `src/pages/portals/TenantPortal.tsx`, 313 lines, `slug="alkalma"`; route
`src/App.tsx:878`; `in_progress`), `/:tenantSlug` (same `TenantPortal.tsx`; route `src/App.tsx:2337`),
`/auth/confirmed` (web `src/pages/auth/EmailConfirmed.tsx`, 112 lines; route `src/App.tsx:825`), `/maxina/confirmed`
(web `src/pages/portals/MaxinaConfirmed.tsx`, 146 lines; route `src/App.tsx:832`), `/alkalma/confirmed` (web
`src/pages/portals/AlkalmaConfirmed.tsx`, 123 lines; route `src/App.tsx:833`), `/oauth/complete` (web
`src/pages/auth/OAuthComplete.tsx`, 250 lines; route `src/App.tsx:829`; `in_progress`), `/oauth/consent` (web
`src/pages/OAuthConsent.tsx`, 176 lines; route `src/App.tsx:1860`, AuthGuard), `/reset-password` (web
`src/pages/auth/ResetPassword.tsx`, 281 lines; route `src/App.tsx:844`; `in_progress`), `/logout` (web
`src/pages/Logout.tsx`, 89 lines; route `src/App.tsx:850`; `in_progress`). The five `in_progress` rows are **completed
to portal chrome**, reusing the N3 functional screens and `src/auth/sign-in.ts` — not re-implemented.
0.3 Lane **`public-legal`** — the signed-out `PublicAppShell` storefront + legal + invite/apply/intro (9 rows):
`PUBLIC.LANDING /` (web `src/pages/Index.tsx`, 179 lines, via `src/pages/ShareEntry.tsx` 107-line fallback; route
`src/App.tsx:819`), `PUBLIC.PRIVACY /privacy` (web `src/pages/legal/PrivacyPolicy.tsx`, 253 lines; route
`src/App.tsx:845`), `PUBLIC.TERMS /terms` (web `src/pages/legal/TermsOfUse.tsx`, 208 lines; route `src/App.tsx:846`),
`/maxina_support` (web `src/pages/legal/MaxinaSupport.tsx`, 240 lines; route `src/App.tsx:848`), `/i/:code` (web
`src/pages/InviteLanding.tsx`, 17 lines; route `src/App.tsx:877`), `/apply` (web `src/pages/Apply.tsx`, 819 lines;
route `src/App.tsx:868`), `/_intro/:tenantSlug` (web `src/pages/IntroExperience.tsx`, 528 lines; route
`src/App.tsx:819`), and the two kept-`exception` rows `/download` (web `src/pages/DownloadFlyer.tsx`, 233 lines; route
`src/App.tsx:862`) and `/maxina/app` (web `src/pages/MaxinaAppRedirect.tsx`, 279 lines; route `src/App.tsx:867`) which
this lane **owns and leaves as web pages** (the installed native app replaces the printed-flyer / QR app-store
redirect — Gate 1 open question 4, planner default). Read-only; no auth write.
0.4 Lane **`onboarding`** — the post-sign-up welcome (1 row): `/onboarding/welcome` (web
`src/pages/onboarding/OnboardingWelcome.tsx`, 224 lines; route `src/App.tsx:837`, AuthGuard) — the Vitana-speech +
name/handle form, the single post-sign-in redirect target (`src/auth/sign-in.ts: postSignInTarget →
/onboarding/welcome`).
## R1 — 1:1 parity with the mobile web screen
1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px / `PublicAppShell` branch,
`src/hooks/use-mobile.tsx`) of its web source — same layout, same sections, same navigation, same wording. No
redesign, no added or removed section, no reordering (program §4 "Allowed native improvements only": platform
transitions, gestures, keyboard avoidance, safe areas, haptics, system sheets — nothing else).
1.2 Screens compose through the N3 shell and the N2 UI kit only: `PublicAppShell`, `TopAppBar`, bottom sheets, `VCard`,
etc. come from `src/ports/*` (`apps/mobile/README.md` "Ports"); no web component, no raw colour, every visual value
from `@vitana/tokens`.
1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`→`@vitana/ui/sonner`, documented `Select`/`Tooltip`/close-button/`Slider`/`Progress` differences). The four
web defects the N2 README lists are **not** reproduced — the native kit's corrected behaviour is used, and no web file
is touched.
1.4 Business logic, query keys, hooks, types are reused from `@vitana/core` (or, for auth, the native
`apps/mobile/src/auth/**` tree), never re-implemented. A web module a lane needs that is not yet re-exported is added
to `packages/core/manifest.json` with a re-export in the same lane PR and `node scripts/native/core-closure.mjs
--write` run (program §3; `apps/mobile/README.md` "Web code: `@vitana/core`"). `@vitana/core` is the only web→native
bridge; ESLint bans `@/` and relative paths into the web `src/` from app code. On current reading no lane needs a core
re-export (the auth tree is already native).
1.5 **Reuse the link + auth plumbing — do not reinvent it.** The reset/confirm/OAuth-return/invite deep links
(`/auth/confirmed`, `/reset-password`, `/oauth/complete`, `/i/:code`) resolve through the already-built pure resolver
`apps/mobile/src/linking/resolve-link.ts`, are dispatched by `apps/mobile/src/linking/link-router.ts` and delivered by
`apps/mobile/src/linking/auth-port.ts`; native `useAuth()` is `apps/mobile/src/auth/AuthProvider.tsx`; the one auth
write lives in `apps/mobile/src/auth/sign-in.ts`. Screens consume these — they do not re-parse links, add a Supabase
redirect URL, or duplicate the OAuth/PKCE logic (g1-wiring VTID-05178, N3 VTID-05186).
1.6 **Sign-in is the one allowed auth write; everything else is read / fixture only, never against production.** No
Supabase config change; the web's own redirect URLs are kept.
## R2 — i18n (11 locales) + RTL
2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n").
2.2 All 11 active locales resolve: **ar de en es fr pl pt ru sr tr zh** (program §1 design-system note; the live
`supported_locales` table has all 11 `status='ga'`). A new key is added to the **German shard first**
(`src/i18n/de/<screen>.json`) then mirrored to the other ten; DE is du-form. Legal/onboarding/intro copy is the area
most likely to need new DE-first keys.
2.3 Each screen works in RTL (`ar`): `start`/`end`, never `left`/`right`; the shell root `direction` follows the
language (`apps/mobile/README.md` N3 "Theme" row). A test scans the lane's files for physical `left`/`right`.
2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first and
mirrors it; a lane that can reuse an existing key (the portals already reference `authPage.*`, `portals.maxina.*`,
`screens.portals.*`) does so and adds none.
## R3 — React 19 / native typing
3.1 React 19 types: no global `JSX` namespace — use `ReactElement` (program hard rule; `.kiro/specs/health-native`
handoff "Hard rules"). `npm run typecheck` (which regenerates the i18n map first) is green.
## R4 — Parity ledger
4.1 Each lane flips its rows from `not_started`/`in_progress` to `native` on completion by running
`node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived fields), and
NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in `apps/mobile/app/`, and no
route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`). The two `exception` rows (`/download`,
`/maxina/app`) are left `exception` and get no native route file.
4.2 No lane changes `scope`/`lane` of a row (those come from `scripts/native/parity-scope.json`); no lane edits
another lane's rows. The three lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is the one
shared path and conflicts resolve by row.
## R5 — Verification and safety (never production)
5.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the production
Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever"). Sign-in is the one
allowed auth write and runs only against the fake Supabase double in unit tests
(`apps/mobile/tests/helpers/supabase-double.ts`), never a live project.
5.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a
**fake gateway / fixtures**, no network), `APP_PROFILE=development npm run bundle` (Metro + Hermes JS for iOS and
Android), and `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` from the repo root. No live call is made.
5.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys, screenshot parity vs the
390×844 web screen) **and the real OAuth browser round-trip** (Apple-on-Android PKCE, Google/Apple native SDK
consent — providers on the G1 test project only) are a **depends-on-owner (G1)** step: they need the isolated test
environment (and macOS minutes / G3 for iOS on a device). Each such task is marked `next_actor: owner` in `tasks.md`
and the lane records G1 as a blocker in its log; it does not block the build-time port landing.
5.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`.
5.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New rule).
## R6 — Done
6.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; RTL (`ar`) covered. The two `exception` rows
stay `exception`.
6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check` and `parity-ledger --check` green;
NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane scope PR-GATE checks green.
6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only spec)
and `plan-sparring.md` (copy of this plan's sparring record).
## Out of scope (named so a lane does not drift into them)
- The two `exception` rows `/download` (`src/pages/DownloadFlyer.tsx`) and `/maxina/app`
  (`src/pages/MaxinaAppRedirect.tsx`) — printed-flyer / QR app-store redirects; they stay web pages and keep
  `status: "exception"`. Owned by `public-legal` so a lane does not port them.
- `DeleteAccount` (`/delete-account`, `src/pages/legal/DeleteAccount.tsx`) — **not** a `public-auth` ledger row; no
  row, out of scope for this plan.
- Any screen in another Wave 2 ledger lane (`home-feed`, `events-calendar`, `media`, `ai`, `discover-commerce`,
  `inbox-chat-calls`, etc.) — each is its own plan.
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module, and the real OAuth provider
  round-trip — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first) and (if needed) a `@vitana/core` re-export line. No Supabase
  config / redirect-URL change.
