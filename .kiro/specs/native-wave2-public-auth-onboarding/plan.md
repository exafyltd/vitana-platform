# Plan — native-wave2-public-auth-onboarding
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2.
<!-- plan:begin -->
## Cross-repo sparring
This plan's implementation lives in `exafyltd/vitana-v1` (native app `apps/mobile/**`, `packages/core/**`, the parity
ledger, i18n shards), while the plan PR itself is in `exafyltd/vitana-platform`. Every load-bearing premise the
sparring partner must verify — the parity-ledger rows for `"lane": "public-auth"`, the `src/App.tsx` routes, the
`PublicAppShell` branch and the public/auth/onboarding/legal web source pages and their class-A/class-B module
classification — is therefore a vitana-v1 file. The partner reads those files through the `spar_refs`
(`exafyltd/vitana-v1: main`) declared in `handoff.md`, which PLAN-SPAR forwards as `extra_refs`; findings about the
frontend half must cite vitana-v1 paths read via that ref.
## Goal
Wave 2 public / auth / onboarding / legal screen-port batch of the native Maxina app: port the signed-out storefront,
the auth surfaces and onboarding/legal screens — the web destinations the parity ledger assigns to
`"lane": "public-auth"` — to the native app (`apps/mobile/`) at 1:1 parity with today's **mobile web** screens (the
`PublicAppShell` branch), built on `@vitana/core` + `@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the Wave 1 N3
shell, with fixture / fake-gateway unit tests. The cluster is the public landing/portal, sign in/up, OAuth complete,
password reset, email confirm, onboarding and legal terms/privacy. Does **not** need G1 planned or built to land the
ports; every device-runtime verification step (and the real OAuth browser round-trip) is marked depends-on-owner (G1).
No redesign (program §4), no new web screen, no `App.tsx` route, no registry/manifest change — only native route files
and parity-row status flips. **Sign-in is the one allowed auth write; everything else is read / fixture only, never
against production.**
## Measured state (worktree = origin/main, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **20 rows** carry `"lane": "public-auth"` (5 `registry` screen rows + 15 `exclusion` route rows); **435 rows
  total**. Counted with `node -e` over the committed ledger JSON (the `--report` CLI needs `typescript`, not installed
  in this worktree). Current status: **2 `exception`** (`/download`, `/maxina/app` — printed-flyer / QR app-store
  redirects that stay web pages, never ported), **5 `in_progress`** (`AUTH.MAXINA_PORTAL`, `AUTH.ALKALMA_PORTAL`,
  `/oauth/complete`, `/reset-password`, `/logout` — N3 (VTID-05186) already landed their functional core), and **13
  `not_started`**. The brief's "~26 routes" is a round number; the ledger authoritatively carries **20**. The 20 rows
  and their web paths are listed in `requirements.md` R0.2–R0.4.
- Web sources verified present with line counts: `src/pages/portals/MaxinaPortal.tsx` (878),
  `src/pages/portals/TenantPortal.tsx` (313, `slug="alkalma"`), `src/pages/Index.tsx` (179) via
  `src/pages/ShareEntry.tsx` (107), `src/pages/legal/PrivacyPolicy.tsx` (253), `src/pages/legal/TermsOfUse.tsx` (208),
  `src/pages/IntroExperience.tsx` (528), `src/pages/auth/EmailConfirmed.tsx` (112),
  `src/pages/portals/MaxinaConfirmed.tsx` (146), `src/pages/portals/AlkalmaConfirmed.tsx` (123),
  `src/pages/auth/OAuthComplete.tsx` (250), `src/pages/OAuthConsent.tsx` (176), `src/pages/auth/ResetPassword.tsx`
  (281), `src/pages/Logout.tsx` (89), `src/pages/InviteLanding.tsx` (17), `src/pages/Apply.tsx` (819),
  `src/pages/onboarding/OnboardingWelcome.tsx` (224), `src/pages/legal/MaxinaSupport.tsx` (240),
  `src/pages/DownloadFlyer.tsx` (233, kept exception), `src/pages/MaxinaAppRedirect.tsx` (279, kept exception); routes
  at `src/App.tsx:819` (`/`), `:825` (`/auth/confirmed`), `:829` (`/oauth/complete`), `:832-833`
  (`/maxina|alkalma/confirmed`), `:844` (`/reset-password`), `:845-846` (`/privacy`, `/terms`), `:848`
  (`/maxina_support`), `:850` (`/logout`), `:868` (`/apply`), `:876` (`/maxina`), `:877` (`/i/:code`), `:878`
  (`/alkalma`), `:837` (`/onboarding/welcome`, AuthGuard), `:1860` (`/oauth/consent`, AuthGuard), `:2337`
  (`/:tenantSlug`). Line counts are an **approximate** scoping snapshot; only the auth-reuse facts below are
  load-bearing.
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). The **g1-wiring lane** (VTID-05178) and
  **N3** already built the link + auth plumbing this plan reuses (see Decision 4). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging
  hosts.
## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Three disjoint lanes by cluster** (prompt: public / auth / onboarding / legal). The 20 rows partition into
   **`auth-portals`** (everything auth — the two portals + their confirm screens, OAuth complete/consent, reset,
   logout), **`public-legal`** (the signed-out `PublicAppShell` storefront + legal + invite/apply/intro, plus the two
   kept-`exception` rows it owns and never ports), and **`onboarding`** (the single post-sign-up welcome screen). The
   three touch disjoint route files and component folders, build/review independently, each leaves the app buildable.
   **Partition against the ledger: auth-portals 10 + public-legal 9 + onboarding 1 = 20**, 0 overlap, 0 orphan (the
   full row-by-row split is in `requirements.md` R0 and each lane file). `onboarding` is kept a distinct small lane
   rather than folded into `auth-portals` because its name/handle form + Vitana-speech is a separate build/review unit
   and keeps `auth-portals` focused on the one auth-write path; it `depends_on: [auth-portals]` as the sign-in redirect
   target.
2. **Five `in_progress` rows are completed to parity, not greenfield-ported.** N3 (VTID-05186) already landed the
   functional sign-in/up, reset, logout and OAuth-return screens (`apps/mobile/app/(public)/{maxina,alkalma,
   reset-password,logout,oauth/complete}.tsx` + `apps/mobile/src/screens/auth/{PortalScreen,OAuthCompleteScreen,
   ResetPasswordScreen,LogoutScreen}.tsx`). The `auth-portals` lane's job on these five rows is **wrapping the existing
   functional screens in the mobile-web portal chrome/visuals** (intro video, events teaser, Orb hint, diag badge per
   the `PortalScreen` header comment) and flipping `in_progress`→`native` — it reuses `PortalScreen` /
   `OAuthCompleteScreen` / `ResetPasswordScreen` / `LogoutScreen` and `src/auth/sign-in.ts`; it never re-implements
   sign-in.
3. **No core extraction is required by any lane** on current reading (R1-F4). The auth flow already lives in the
   native `apps/mobile/src/auth/**` tree, not in `@vitana/core`; the public-legal and onboarding screens are static
   content + existing hooks. The one caveat: if a ported screen needs a **pure, class-A** web helper not yet in
   `@vitana/core` (e.g. a legal-copy or invite-code formatting helper), that lane adds a single re-export line to
   `packages/core/manifest.json` + `packages/core/src/**` and in the **same PR** runs
   `node scripts/native/core-closure.mjs --write`, committing the regenerated `packages/core/closure.generated.json`
   and `scripts/native/mobile-ci-paths.generated.json`. **Never move a class-B module** (anything reaching
   `src/integrations/supabase/client.ts`, `import.meta.env`, `localStorage`, the prod Supabase URL) into core —
   `core-closure --check` fails on it. A lane adds the `packages/core/**` + generated-paths globs to its `paths`
   **only if** it turns out to add such a re-export.
4. **Reuse the g1-wiring / N3 link + auth plumbing — do not reinvent it.** The deep links the brief names resolve
   through the already-built pure resolver and router, not through screen code: `apps/mobile/src/linking/
   resolve-link.ts` tags `/auth/confirmed` and `/reset-password` → `auth`, `/oauth/complete` → `oauth_return`,
   `/i/:code` → `invite`; `apps/mobile/src/linking/link-router.ts` (`createLinkRouter`/`useLinkRouting`) dispatches
   them; `apps/mobile/src/linking/auth-port.ts` is the session seam (`deliverAuthLink`/`deliverInviteLink`,
   `getSession`/`setSession`/`subscribeSession`); `apps/mobile/src/auth/AuthProvider.tsx` is native `useAuth()`;
   `apps/mobile/src/auth/sign-in.ts` is the **only** place that performs an auth write (`signInWithPassword`,
   `signUpWithPassword`, `sendPasswordReset`, `signInWithApple*`, `signInWithGoogle`, `exchangeCode`,
   `postSignInTarget` → `/onboarding/welcome`). Screens consume these; they do not re-parse links, add a Supabase
   redirect URL, or duplicate the OAuth/PKCE logic.
5. **Sign-in is the one allowed auth write; everything else is read / fixture only, never against production.** No
   Supabase config change; the web's own redirect URLs are kept. Unit tests use the fake gateway / Supabase double
   (`apps/mobile/tests/helpers/supabase-double.ts`); the native app has **no production profile** and
   `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the production Supabase project and the
   staging hosts (`apps/mobile/README.md` "No production host, ever"; root `CLAUDE.md` absolute rule).
6. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips (`not_started`/`in_progress` → `native`). The two
   `exception` rows (`/download`, `/maxina/app`) stay web pages and keep `status: "exception"` (named in Out of scope
   so a lane does not port them).
7. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px / `PublicAppShell`
   branch of its source (program §1 shell), composed through N3/N2, every visual value from `@vitana/tokens`; the N2
   web defects are not reproduced and no web file is touched beyond a DE-first i18n key and (if needed) a
   `@vitana/core` re-export line. Signed-out screens live under `apps/mobile/app/(public)/`; the two `AuthGuard` routes
   (`/oauth/consent`, `/onboarding/welcome`) live under `apps/mobile/app/(app)/`.
## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `auth-portals` | exafyltd → hotmail | `AUTH.MAXINA_PORTAL /maxina`, `AUTH.ALKALMA_PORTAL /alkalma`, `/:tenantSlug`, `/auth/confirmed`, `/maxina/confirmed`, `/alkalma/confirmed`, `/oauth/complete`, `/oauth/consent`, `/reset-password`, `/logout` (**10 rows**); completes the 5 N3 functional screens to portal chrome and reuses the one auth-write path `src/auth/sign-in.ts` | — |
| `public-legal` | exafyltd → hotmail | `PUBLIC.LANDING /`, `PUBLIC.PRIVACY /privacy`, `PUBLIC.TERMS /terms`, `/maxina_support`, `/i/:code`, `/apply`, `/_intro/:tenantSlug`, plus the two kept-`exception` rows `/download`, `/maxina/app` it owns and leaves as web pages (**9 rows**); the signed-out `PublicAppShell` branch, read-only | — |
| `onboarding` | exafyltd → hotmail | `/onboarding/welcome` — the post-sign-up Vitana-speech + name/handle form behind `AuthGuard`, the single post-sign-in redirect target (`sign-in.ts: postSignInTarget`) (**1 row**) | `auth-portals` |
Exact `paths` globs are in each `lanes/<id>.md`; the 20 parity rows partition **10 (auth-portals) + 9 (public-legal) +
1 (onboarding)** with 0 overlap and 0 orphan (row-by-row in `requirements.md` R0). `public-legal` keeps its two
`exception` rows as web pages (no port). `auth-portals` and `public-legal` have no deps and run in parallel; `onboarding`
waits for `auth-portals` (the sign-in → onboarding redirect seam and shared auth session / `usePostSignIn`).
## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; the portals' sign-in/up tabs and fields, OAuth-return state,
  reset/confirm deep-link resolution through `resolve-link`/`link-router`/`auth-port`, invite-code landing, the
  onboarding name/handle form; i18n no-raw-text + RTL start/end; React 19 `ReactElement`),
  `APP_PROFILE=development npm run bundle`, `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo
  root — `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Auth write:** only sign-in exercises an auth write; it runs against the fake Supabase double in unit tests, never a
  live project. Reset/confirm/OAuth-return deep links resolve through the existing `resolve-link` / `link-router` /
  `auth-port` (reused, not reinvented); tests assert the resolver tags and the router dispatch, not a live round-trip.
- **Core extraction deliverable (only if a lane adds a re-export):** the PR that adds a `@vitana/core` re-export entry
  MUST also run `node scripts/native/core-closure.mjs --write` and commit the regenerated
  `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` in the SAME PR; then
  `node scripts/native/core-closure.mjs --check` passes. Never move a class-B module into core. On current reading no
  lane needs this.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (ar de en es fr pl pt ru sr tr zh), any new key DE-first (du-form) then mirrored; RTL (`ar`)
  rendered per screen — load-bearing for onboarding/legal copy.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/<lane>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen, and the
  **real OAuth browser round-trip on a device** (Apple-on-Android PKCE via `WebBrowser.openAuthSessionAsync`,
  Google/Apple native SDK consent — the providers exist only on the G1 test project, never on production auth); listed
  in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every non-GET except
  sign-in; never `vitanaland.com`). STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native parity
  row — only status flips.
## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check and before the live
  OAuth browser round-trip; the deferred tasks stay `next_actor: owner` until it exists.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- 2-lane vs 3-lane: `onboarding` can fold into `auth-portals` if sparring prefers two; default is the 3-lane split
  above (Decision 1).
- Whether any legal-copy / invite-code helper needs a `@vitana/core` re-export (Decision 3 default: none; the lane adds
  it in-PR with `core-closure --write` if it turns out to).
<!-- plan:end -->
