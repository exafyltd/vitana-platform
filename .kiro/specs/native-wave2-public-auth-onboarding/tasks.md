# Tasks — Native Wave 2: Public / Auth / Onboarding / Legal screen ports
Three lanes, disjoint `paths`. Design: `design.md` and `requirements.md` in this folder are authoritative — follow
them exactly; anything outside them is a plan change (log it, set `next_actor: claude`). VTIDs are assigned by CI
after PLAN-SPAR converges; do not start a lane before its `vtid:` is set in `lanes/<id>.md`. All commands run from
`apps/mobile/` unless noted; `assertNotProduction()` and the no-production-profile rule make every command offline.
Sign-in is the one allowed auth write (fake Supabase double in unit tests); the reset/confirm/OAuth-return/invite deep
links resolve through the existing `apps/mobile/src/linking/{resolve-link,link-router,auth-port}.ts` — reuse them, do
not reinvent.
<!-- lane: auth-portals -->
## Lane `auth-portals` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (10 ledger rows under `"lane": "public-auth"`): `AUTH.MAXINA_PORTAL /maxina`, `AUTH.ALKALMA_PORTAL /alkalma`,
`/:tenantSlug`, `/auth/confirmed`, `/maxina/confirmed`, `/alkalma/confirmed`, `/oauth/complete`, `/oauth/consent`,
`/reset-password`, `/logout`. depends_on: none. Web sources `src/pages/portals/MaxinaPortal.tsx` (878, route
`src/App.tsx:876`), `src/pages/portals/TenantPortal.tsx` (313, `slug="alkalma"`, routes `:878`/`:2337`),
`src/pages/auth/EmailConfirmed.tsx` (112, `:825`), `src/pages/portals/MaxinaConfirmed.tsx` (146, `:832`),
`src/pages/portals/AlkalmaConfirmed.tsx` (123, `:833`), `src/pages/auth/OAuthComplete.tsx` (250, `:829`),
`src/pages/OAuthConsent.tsx` (176, `:1860`, AuthGuard), `src/pages/auth/ResetPassword.tsx` (281, `:844`),
`src/pages/Logout.tsx` (89, `:850`). Five rows (`/maxina`, `/alkalma`, `/oauth/complete`, `/reset-password`,
`/logout`) are **`in_progress`** — N3 landed their functional core; this lane **completes them to portal chrome**,
reusing `apps/mobile/src/screens/auth/{PortalScreen,OAuthCompleteScreen,ResetPasswordScreen,LogoutScreen}.tsx` and
`apps/mobile/src/auth/sign-in.ts` — never a re-implementation of sign-in.
- [ ] 1. Complete the two portal screens to mobile-web parity: wrap the existing functional `PortalScreen`
  (sign-in/up tabs + fields for `/maxina` and `/alkalma`, `TenantPortal` `slug="alkalma"`) in the `PublicAppShell`
  portal chrome/visuals the web shows — intro video, events teaser, Orb hint, diag badge (per the `PortalScreen`
  header comment and `MaxinaPortal.tsx`) — and add the generic `/:tenantSlug` portal route. Reuse `src/auth/sign-in.ts`
  (the one auth-write path); do not duplicate it. Mobile-web branch only.
  Files: `apps/mobile/app/(public)/maxina.tsx`, `apps/mobile/app/(public)/alkalma.tsx`,
  `apps/mobile/app/(public)/[tenantSlug].tsx`, `apps/mobile/src/screens/auth/**`.
  Verify: `npm test` (portal sign-in/up tab + field tests) + `npm run typecheck` green.
- [ ] 2. Email/portal confirm screens: native twins of `EmailConfirmed.tsx`, `MaxinaConfirmed.tsx`,
  `AlkalmaConfirmed.tsx`. The `/auth/confirmed` deep link resolves through `resolve-link` (→ `auth`) and is delivered
  by `auth-port` — the screen renders the confirmed state and the post-confirm CTA, it does not re-parse the link.
  Files: `apps/mobile/app/(public)/auth/confirmed.tsx`, `apps/mobile/app/(public)/maxina/confirmed.tsx`,
  `apps/mobile/app/(public)/alkalma/confirmed.tsx`, `apps/mobile/src/screens/auth/**`.
  Verify: `npm test` (confirm-screen + deep-link resolution tests) + `npm run typecheck` green.
- [ ] 3. OAuth complete + consent and reset/logout to parity: complete the `in_progress` `OAuthCompleteScreen`,
  `ResetPasswordScreen` and `LogoutScreen` to mobile-web parity, and add the `AuthGuard` `/oauth/consent` screen (twin
  of `OAuthConsent.tsx`, MCP consent). OAuth-return resolves through `resolve-link` (→ `oauth_return`) + `auth-port`
  and consumes `src/auth/sign-in.ts` (`exchangeCode`); `/reset-password` resolves through `resolve-link` (→ `auth`)
  and uses `sendPasswordReset`. The real browser round-trip is a G1 device task (task 6).
  Files: `apps/mobile/app/(public)/oauth/complete.tsx`, `apps/mobile/app/(app)/oauth/consent.tsx`,
  `apps/mobile/app/(public)/reset-password.tsx`, `apps/mobile/app/(public)/logout.tsx`,
  `apps/mobile/src/screens/auth/**`, `apps/mobile/src/auth/**`.
  Verify: `npm test` (OAuth-return / reset / consent / logout state tests) + `npm run typecheck` green.
- [ ] 4. i18n + RTL: user-visible strings (incl. `accessibilityLabel`/`accessibilityHint`) from the web shards; any
  genuinely new key added to `src/i18n/de/authPortalsNative.json` first, then the other ten (ar de en es fr pl pt ru
  sr tr zh); render under `ar` with start/end only; no hardcoded text, no physical `left`/`right`.
  Files: `src/i18n/*/authPortalsNative.json` (DE first), `apps/mobile/src/screens/auth/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 5. Unit tests (fake gateway / Supabase double, no network): portal sign-in/up tab switch + field validation;
  sign-in success (the one allowed auth write, against the double) → `postSignInTarget` is `/onboarding/welcome`;
  reset-request flow; `/auth/confirmed` and `/reset-password` resolve to `auth`, `/oauth/complete` to `oauth_return`
  via `resolve-link`; confirm screens loaded/expired; logout. React 19 — `ReactElement`, no global `JSX`.
  Files: `apps/mobile/tests/auth/**`, `apps/mobile/src/screens/auth/__tests__/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip the lane's 10 parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync`
  (status edited by hand to `native` for the 5 `in_progress` + 5 `not_started` rows), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (auth-portals rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity + the **real OAuth browser
  round-trip** (Apple-on-Android PKCE via `WebBrowser.openAuthSessionAsync`, Google/Apple native SDK consent — the
  providers exist only on the G1 test project, never production auth): Maestro journey(s)
  `apps/mobile/maestro/auth/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes, screenshot
  parity vs the 390×844 read-only staging portals/reset/confirm screens. Blocked until G1 (and macOS minutes / G3 for
  iOS on a device).
  Files: `apps/mobile/maestro/auth/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 8. PR: branch `kiro/native-wave2-public-auth-onboarding/auth-portals`, title
  `VTID-xxxxx (native-wave2-public-auth-onboarding/auth-portals): native portals / OAuth / reset / confirm port`, body
  names the Kiro session id, Summary / Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-public-auth-onboarding/auth-portals`. Lane → `in-review`, `next_actor: kiro` (reviewer
  seat `hotmail`). Never merge, deploy or write to a live system (protocol §7a).
<!-- lane: public-legal -->
## Lane `public-legal` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (9 ledger rows): `PUBLIC.LANDING /`, `PUBLIC.PRIVACY /privacy`, `PUBLIC.TERMS /terms`, `/maxina_support`,
`/i/:code`, `/apply`, `/_intro/:tenantSlug`, plus the two kept-`exception` rows `/download`, `/maxina/app` it owns and
**leaves as web pages** (no port). depends_on: none. Web sources `src/pages/Index.tsx` (179) via
`src/pages/ShareEntry.tsx` (107) fallback (route `src/App.tsx:819`), `src/pages/legal/PrivacyPolicy.tsx` (253, `:845`),
`src/pages/legal/TermsOfUse.tsx` (208, `:846`), `src/pages/legal/MaxinaSupport.tsx` (240, `:848`),
`src/pages/InviteLanding.tsx` (17, `:877`), `src/pages/Apply.tsx` (819, `:868`), `src/pages/IntroExperience.tsx`
(528, `:819`). The signed-out `PublicAppShell` branch — read-only, no auth write.
- [ ] 1. Landing + legal static screens: native twins of the `PublicAppShell`/`Index`/`ShareEntry` landing, Privacy,
  Terms and Maxina Support. Mobile-web branch only; static content through `VCard`/`ScrollView`, every visual value
  from `@vitana/tokens`. The native landing redirect (`app/index.tsx`, VTID-05186) is NOT this row — `PUBLIC.LANDING`
  is the storefront content screen.
  Files: `apps/mobile/app/(public)/index.tsx`, `apps/mobile/app/(public)/privacy.tsx`,
  `apps/mobile/app/(public)/terms.tsx`, `apps/mobile/app/(public)/maxina_support.tsx`,
  `apps/mobile/src/screens/public/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Invite + apply + intro: `/i/:code` invite landing (twin of `InviteLanding.tsx`; the link resolves through
  `resolve-link` → `invite` and is delivered by `auth-port` `deliverInviteLink` — the screen reads the delivered code,
  it does not re-parse the link), the `/apply` application screen (twin of `Apply.tsx`), and the `/_intro/:tenantSlug`
  intro experience (twin of `IntroExperience.tsx`). Read-only / fixture; no auth write.
  Files: `apps/mobile/app/(public)/i/[code].tsx`, `apps/mobile/app/(public)/apply.tsx`,
  `apps/mobile/app/(public)/_intro/[tenantSlug].tsx`, `apps/mobile/src/screens/public/**`.
  Verify: `npm test` (invite-code resolution + apply/intro render tests) + `npm run typecheck` green.
- [ ] 3. i18n + RTL (as auth-portals task 4) across the landing/legal/invite/apply/intro screens; new keys DE-first
  (du-form) then the other ten. Legal/intro copy is the most likely to need new DE-first keys; reuse existing keys
  where they exist and add none.
  Files: `src/i18n/*/publicLegalNative.json` (DE first), `apps/mobile/src/screens/public/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 4. Unit tests (fake gateway / fixtures, no network): landing render; privacy/terms/support static render; invite
  `/i/:code` resolves to `invite` and shows the invite state; apply form render + validation (no submit against a live
  system); intro render. React 19 `ReactElement`.
  Files: `apps/mobile/tests/public/**`, `apps/mobile/src/screens/public/__tests__/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the lane's 7 ported parity rows to `native` and verify; leave `/download` and `/maxina/app`
  `status: "exception"` untouched: `node scripts/native/parity-ledger.mjs --sync`, then `--check`.
  Files: `apps/mobile/parity/ledger.json` (public-legal rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey(s)
  `apps/mobile/maestro/public/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes, screenshot
  parity vs the 390×844 read-only staging `/`, `/privacy`, `/terms`, `/maxina_support`, `/apply` screens. Blocked until
  G1 (and macOS minutes / G3 for iOS on a device).
  Files: `apps/mobile/maestro/public/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 7. PR: branch `kiro/native-wave2-public-auth-onboarding/public-legal`, title
  `VTID-xxxxx (native-wave2-public-auth-onboarding/public-legal): native public landing / legal / invite / apply port`;
  trailers `Collab-Session`, `Collab-Lane: native-wave2-public-auth-onboarding/public-legal`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.
<!-- lane: onboarding -->
## Lane `onboarding` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports (1 ledger row): `/onboarding/welcome` — the post-sign-up Vitana-speech + name/handle form, behind `AuthGuard`.
depends_on: `auth-portals` (it is the sign-in redirect target, `src/auth/sign-in.ts: postSignInTarget →
/onboarding/welcome`, and shares the auth session / `usePostSignIn` seam). Web source
`src/pages/onboarding/OnboardingWelcome.tsx` (224, route `src/App.tsx:837`, AuthGuard).
- [ ] 1. Native onboarding welcome screen on the N3 shell under the `(app)` group (AuthGuard): twin of
  `OnboardingWelcome.tsx` — the Vitana-speech intro + the name/handle form, consuming the authenticated session from
  `AuthProvider`/`usePostSignIn`. The post-sign-in redirect from `auth-portals` lands here. Mobile-web branch only.
  Files: `apps/mobile/app/(app)/onboarding/welcome.tsx`, `apps/mobile/src/screens/onboarding/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. i18n + RTL (as auth-portals task 4): onboarding copy from the web shards; new keys DE-first (du-form) then
  the other ten; render under `ar` with start/end only. Onboarding copy is load-bearing for the 11-locale + RTL check.
  Files: `src/i18n/*/onboardingNative.json` (DE first), `apps/mobile/src/screens/onboarding/**`.
  Verify: `npm run typecheck`; `npm test` — the no-raw-text and no-physical-direction tests pass.
- [ ] 3. Unit tests (fake gateway / fixtures, no network): welcome render; name/handle form validation; the
  authenticated-session guard (unauthenticated → redirect); the sign-in → `/onboarding/welcome` redirect seam resolves.
  React 19 `ReactElement`.
  Files: `apps/mobile/tests/onboarding/**`, `apps/mobile/src/screens/onboarding/__tests__/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 4. Flip the `/onboarding/welcome` parity row to `native` and verify: `node scripts/native/parity-ledger.mjs
  --sync`, then `--check`.
  Files: `apps/mobile/parity/ledger.json` (onboarding row only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 5. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro journey
  `apps/mobile/maestro/onboarding/*.yaml`, iOS simulator + Android emulator screenshots at the device sizes,
  screenshot parity vs the 390×844 read-only staging `/onboarding/welcome` (signed in, read-only). Blocked until G1
  (and macOS minutes / G3 for iOS on a device).
  Files: `apps/mobile/maestro/onboarding/**`, `docs/validation/<VTID>/staging-tests.json`.
  Verify: on G1 only; recorded in the lane log, not run in CI.
- [ ] 6. PR: branch `kiro/native-wave2-public-auth-onboarding/onboarding`, title
  `VTID-xxxxx (native-wave2-public-auth-onboarding/onboarding): native onboarding welcome port`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-public-auth-onboarding/onboarding`; lane → `in-review`,
  `next_actor: kiro`. No merge/deploy/live write.
## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity (the `PublicAppShell` branch), N2/N3 composition,
  `@vitana/core`-only bridge; the g1-wiring/N3 link + auth plumbing reused (resolve-link / link-router / auth-port /
  AuthProvider / sign-in), never reinvented.
- Sign-in is the only auth write, exercised against the fake Supabase double; no test touches production.
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; if a lane added a core re-export, `node scripts/native/core-closure.mjs --check`
  green.
- 11 locales, DE-first new keys, RTL covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Device-runtime parity and the live OAuth browser round-trip (the last device task) are deferred to G1 as
  `next_actor: owner`; they are not a merge blocker for the port, they are recorded in the lane log and
  `staging-tests.json`.
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
