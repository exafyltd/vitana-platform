# Design — Native Wave 2: Public / Auth / Onboarding / Legal screen ports (native-wave2-public-auth-onboarding-r3)
How the three lanes port the `public-auth` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §3 (architecture) and §4 (parity method), the N3 shell and N2 UI kit
already on main, the g1-wiring / N3 link + auth plumbing already on main, and `apps/mobile/README.md`. Nothing here
changes the program plan or the design contract.
## 1. Where native screens live and how they resolve
Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console, unknown as not-found. Porting a
screen means **adding its own Expo Router file under `apps/mobile/app/`** whose route path equals the web path, so the
resolver no longer catches it, the push `data.url` / universal link / ORB directive / deep link resolve the same, and
the parity row can go `native` (`scripts/native/parity-ledger.mjs` `fileToRoute()` maps `app/(app)/foo/[id].tsx` →
`/foo/:id`).
Signed-out screens live under the `(public)` route group (`apps/mobile/app/(public)/`, `headerShown:false`, no shell
chrome — already created by N3). The two `AuthGuard` routes (`/oauth/consent`, `/onboarding/welcome`) live under the
`(app)` group. Route-file plan (Expo Router, paths = web paths):
| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) |
|---|---|---|
| `auth-portals` | `(public)/maxina.tsx`, `(public)/alkalma.tsx`, `(public)/[tenantSlug].tsx`, `(public)/auth/confirmed.tsx`, `(public)/maxina/confirmed.tsx`, `(public)/alkalma/confirmed.tsx`, `(public)/oauth/complete.tsx`, `(app)/oauth/consent.tsx`, `(public)/reset-password.tsx`, `(public)/logout.tsx` | `/maxina`, `/alkalma`, `/:tenantSlug`, `/auth/confirmed`, `/maxina/confirmed`, `/alkalma/confirmed`, `/oauth/complete`, `/oauth/consent`, `/reset-password`, `/logout` |
| `public-legal` | `(public)/index.tsx`, `(public)/privacy.tsx`, `(public)/terms.tsx`, `(public)/maxina_support.tsx`, `(public)/i/[code].tsx`, `(public)/apply.tsx`, `(public)/_intro/[tenantSlug].tsx` — and NO file for `/download`, `/maxina/app` (kept `exception`) | `/`, `/privacy`, `/terms`, `/maxina_support`, `/i/:code`, `/apply`, `/_intro/:tenantSlug` |
| `onboarding` | `(app)/onboarding/welcome.tsx` | `/onboarding/welcome` |
Query-string variants (the portals' sign-in/up tab, `?view=`, etc.) are the **same route file** reading the search
param, exactly as the web screen reads `useSearchParams()`. The five N3 `in_progress` files
(`(public)/{maxina,alkalma,reset-password,logout,oauth/complete}.tsx`) already exist — the `auth-portals` lane edits
them to add portal chrome, it does not create new files for those five.
## 2. Screen source: the N2/N3 structure, not the web DOM
Each lane re-implements the **mobile web** / `PublicAppShell` branch of its source screen with React Native
primitives:
- Imports go through ports only: `@vitana/core/*` (hooks, query keys, types, registry), `@vitana/ui` (UI kit),
  `@vitana/tokens` (visual values), `src/ports/*` from the shell, and the native auth/linking trees
  `apps/mobile/src/auth/*` + `apps/mobile/src/linking/*`. No `@/…` web import (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`,
  shadcn `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`/`ResponsiveDialog`→the kit's modal / bottom sheet,
  `toast`/`notify*`→`@vitana/ui`/`@vitana/ui/sonner`, list/scroll→`FlatList`/`ScrollView`.
- Deep links are NOT re-parsed in screens: `resolve-link.ts` tags the route kind, `link-router.ts` dispatches it,
  `auth-port.ts` delivers the session/invite payload. A screen reads the delivered state through `AuthProvider` /
  the auth-port session accessors.
### 2a. `auth-portals` lane specifics (the one auth-write lane)
The portals (`/maxina`, `/alkalma`, `/:tenantSlug`) share the N3 `PortalScreen` — the sign-in/up tabs + fields. N3
landed the **functional** sign-in/up, reset, logout and OAuth-return screens; this lane's job on those five
`in_progress` rows is **parity completion**: wrap `PortalScreen`/`OAuthCompleteScreen`/`ResetPasswordScreen`/
`LogoutScreen` in the mobile-web portal chrome the web shows (intro video, events teaser, Orb hint, diag badge — the
`PortalScreen` header comment records these as the reason the rows are `in_progress`, not `native`), then flip to
`native`. The confirm screens (`/auth/confirmed`, `/maxina/confirmed`, `/alkalma/confirmed`) and `/oauth/consent`
(AuthGuard MCP consent) are new leaf screens. The **one auth write** is sign-in, performed by
`apps/mobile/src/auth/sign-in.ts` (`signInWithPassword` / `signUpWithPassword` / `sendPasswordReset` /
`signInWithApple*` / `signInWithGoogle` / `exchangeCode`) — reused, never duplicated; `postSignInTarget` returns
`/onboarding/welcome`, the seam the `onboarding` lane depends on. Apple/Google OAuth uses the native SDKs +
`signInWithIdToken`; Android-Apple is the browser round-trip (`WebBrowser.openAuthSessionAsync` → `/oauth/complete`),
a **G1 device** behaviour — build-time lands with fixture / fake-gateway tests, the live round-trip is verified under
G1. Web parity references: `src/hooks/useSupabaseOAuthSignIn.ts` (the WebView OAuth gesture trick the native SDK path
replaces), `src/pages/auth/OAuthComplete.tsx`, `src/pages/portals/MaxinaPortal.tsx`.
### 2b. `public-legal` lane specifics (read-only `PublicAppShell`)
The signed-out storefront landing (`PublicAppShell`/`Index` via `ShareEntry` fallback), Privacy, Terms, Maxina Support
are static content screens through `VCard`/`ScrollView`. `/i/:code` invite landing resolves through `resolve-link` →
`invite` and `auth-port` `deliverInviteLink` — the screen reads the delivered code, it does not re-parse. `/apply` is
the application screen; `/_intro/:tenantSlug` is the intro experience. The native landing redirect (`app/index.tsx`,
VTID-05186) is **not** `PUBLIC.LANDING` — that is the storefront content screen; the redirect row stays as N3 left it.
The two `exception` rows (`/download`, `/maxina/app`) are **not ported** — they stay web pages (the installed native
app replaces the printed-flyer / QR app-store redirect) and keep `status: "exception"`; this lane owns them only to
name them so no lane drifts into porting them. No auth write anywhere in this lane.
### 2c. `onboarding` lane specifics
`/onboarding/welcome` (AuthGuard) is the post-sign-up Vitana-speech intro + name/handle form, under the `(app)`
group. It consumes the authenticated session from `AuthProvider` / `usePostSignIn`; the sign-in redirect from
`auth-portals` (`postSignInTarget → /onboarding/welcome[?redirectTo=]`) lands here, which is why this lane
`depends_on: [auth-portals]`. Twin of `src/pages/onboarding/OnboardingWelcome.tsx`, mobile-web branch only; no new
auth write (the account already exists at this point).
## 3. Disjointness (no overlap, no orphan)
- **Ledger rows:** the 20 `public-auth` rows partition cleanly — `auth-portals` 10 (`AUTH.MAXINA_PORTAL`,
  `AUTH.ALKALMA_PORTAL`, `/:tenantSlug`, `/auth/confirmed`, `/maxina/confirmed`, `/alkalma/confirmed`,
  `/oauth/complete`, `/oauth/consent`, `/reset-password`, `/logout`), `public-legal` 9 (`PUBLIC.LANDING`,
  `PUBLIC.PRIVACY`, `PUBLIC.TERMS`, `/maxina_support`, `/i/:code`, `/apply`, `/_intro/:tenantSlug`, `/download`
  (exception), `/maxina/app` (exception)), `onboarding` 1 (`/onboarding/welcome`). 10 + 9 + 1 = 20. Each row named
  explicitly in the lane file.
- **Native files:** each lane owns a disjoint set of `apps/mobile/app/` route files (pinned by explicit file name, not
  a `(public)/**` wildcard, so `auth-portals` and `public-legal` never claim the same route file) and a disjoint
  `apps/mobile/src/screens/` folder (`src/screens/auth/`, `src/screens/public/`, `src/screens/onboarding/`). No file is
  in two lanes. `apps/mobile/src/auth/**` and `apps/mobile/src/linking/**` are reused, not owned — only `auth-portals`
  may extend `src/auth/sign-in.ts` (the auth-write path).
- **Tests:** each lane owns `apps/mobile/tests/<cluster>/` + its screen `__tests__/` and its `docs/validation/<VTID>/`
  folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows),
  `apps/mobile/src/navigation/resolve.ts` (resolver registration, by-entry), and the DE-first i18n shards (each lane
  adds only its screens' keys). If a lane turns out to add a `@vitana/core` re-export, `packages/core/manifest.json` +
  `packages/core/src/**` closure are shared the same by-line way. These are listed in each lane's `paths`.
## 4. Decisions (made by Kiro as planner; sparring may revise)
1. **Three lanes, not one.** The prompt asks for disjoint lanes across public / auth / onboarding / legal. The split
   is `auth-portals` (all auth, the one write path), `public-legal` (the read-only `PublicAppShell` storefront + legal
   + invite/apply/intro), and `onboarding` (the single AuthGuard welcome). Rationale: the three clusters touch disjoint
   route files and components, can be built and reviewed independently, and each leaves the app buildable.
   `onboarding` is kept distinct (not folded into `auth-portals`) because its form + Vitana-speech is a separate
   build/review unit; sparring may fold it for a 2-lane split.
2. **Reuse the link + auth plumbing; no core extraction.** The auth flow already lives in the native
   `apps/mobile/src/auth/**` + `apps/mobile/src/linking/**` tree (not in `@vitana/core`), and the public-legal /
   onboarding screens are static content + existing hooks — so no lane needs a core re-export on current reading. If a
   ported screen needs a pure class-A helper not yet in core, that lane adds one re-export line + runs
   `core-closure.mjs --write` in the same PR; never a class-B module.
3. **Five `in_progress` rows are completed to parity, not greenfield.** The `auth-portals` lane reuses the N3
   `PortalScreen`/`OAuthCompleteScreen`/`ResetPasswordScreen`/`LogoutScreen` and `src/auth/sign-in.ts`, adds the
   mobile-web portal chrome, and flips `in_progress` → `native`. It never re-implements sign-in.
4. **No new routes / registry / manifest.** These are ports of screens that already exist in `App.tsx` and
   `screens.json`; adding a native route file is not an `App.tsx` route, so the "new page needs
   screens.json/exclusions.json + screen-manifest + parity rows" rule does not fire — only parity-row **status**
   flips. The two `exception` rows stay `exception`.
5. **Sign-in is the one allowed auth write; everything else read / fixture only.** No test touches production; the
   native app has no production profile; `assertNotProduction()` refuses prod/staging hosts. Runtime verification and
   the real OAuth browser round-trip are deferred to G1 (`next_actor: owner`).
## 5. Test design (per lane)
- **Unit (jest-expo + RNTL, fake gateway / Supabase double):** each screen renders its loaded / empty / error state
  from fixture data. `auth-portals`: portal sign-in/up tab switch + field validation, sign-in success (the one auth
  write, against the double) → `postSignInTarget` is `/onboarding/welcome`, reset-request, confirm loaded/expired,
  OAuth-return state, logout; `/auth/confirmed` + `/reset-password` resolve to `auth`, `/oauth/complete` to
  `oauth_return` via `resolve-link`. `public-legal`: landing/legal static render, `/i/:code` resolves to `invite` and
  shows the invite state, apply form validation (no live submit), intro render. `onboarding`: welcome render,
  name/handle validation, the AuthGuard (unauthenticated → redirect), the sign-in → welcome seam. No network — the
  gateway/Supabase doubles are fixtures.
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical `left`/`right`;
  renders one screen under `ar` (RTL) and asserts start/end.
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Parity:** `node scripts/native/parity-ledger.mjs --check` from the repo root (rows `native`, routes present; the
  two `exception` rows stay `exception`). If a lane added a core re-export, `node scripts/native/core-closure.mjs
  --check`.
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `maestro/<cluster>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 read-only staging web screen, and the
  **real OAuth browser round-trip** (Apple-on-Android PKCE, Google/Apple native SDK consent), listed in
  `docs/validation/<VTID>/staging-tests.json`.
## 6. Open items for the owner / sparring
- G1 isolated test environment (program gate) is required before any device-runtime parity check and before the real
  OAuth provider round-trip; until then the deferred tasks stay `next_actor: owner`.
- 2-lane vs 3-lane: `onboarding` can fold into `auth-portals` (decision 1 default: keep 3).
- Whether any legal-copy / invite-code helper needs a `@vitana/core` re-export (decision 2 default: none).
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
