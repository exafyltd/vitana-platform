# Requirements — Native Wave 2: Role-mode screen ports (native-wave2-role-modes)

Wave 2 screen-port batch of the Maxina native app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021). Port the role-mode web screens the parity
ledger assigns to the `role-modes` lane — the patient, professional, staff and business (commerce) mode screens — to
the native app (`apps/mobile/`) at 1:1 parity with today's **mobile web** screens, built on `@vitana/core` +
`@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the N3 shell. Fixture / fake-gateway tests only; runtime
verification on a device needs the isolated test environment G1 and is called out per task as `depends-on-owner`.

Measured on `exafyltd/vitana-v1` `origin/main`, parity ledger `apps/mobile/parity/ledger.json` version 2:
**35 rows carry `"lane": "role-modes"`, every one `status: "not_started"`** (34 `source: role-route`, 1
`source: exclusion` — `/commerce/connect/authorize`; 435 rows total). Counted with `node -e` over the committed
ledger JSON. The four lanes below partition those 35 rows with **disjoint `paths`** by role prefix
(patient 8 + professional 8 + staff 8 + business 11 = 35; 0 overlap, 0 orphan — verified).

Contract that does not change: `docs/programs/native-app/NATIVE-APP-PLAN.md` §2 (admin → in-app system browser,
decisions 3/7), §4 (parity method), §6 (verification & safety), the N2 README web→native prop map
(`apps/mobile/README.md` "Web → native prop map"), and the Spotlight / design rules via tokens. No new web screen,
no `App.tsx` route, no `screens.json` / `exclusions.json` entry is added by this plan (ports only), so no
`screen-manifest` or voice-registry change and no new native parity row — only status flips on existing rows.

## R0 — Scope and the four lanes

0.1 The plan ports exactly the 35 web destinations the parity ledger lists under `"lane": "role-modes"`, split into
four disjoint lanes by role prefix (`/patient/*`, `/professional/*`, `/staff/*`, `/commerce*`). No row is in two
lanes; no row in scope is left without a lane. The single `source: exclusion` row `/commerce/connect/authorize`
belongs to the `business` lane, which flips it alongside its role-route rows.

0.2 Lane **`patient`** — the patient-mode screens (8 rows, all `not_started`):
`/patient/appointments`, `/patient/care-team`, `/patient/dashboard`, `/patient/goals`, `/patient/health`,
`/patient/insurance`, `/patient/notifications`, `/patient/results`. Patient mode carries its own bottom tabs
(`design.md` §2a). Web sources under `src/pages/patient/*`.

0.3 Lane **`professional`** — the professional-mode screens (8 rows, all `not_started`):
`/professional/billing`, `/professional/dashboard`, `/professional/education`, `/professional/patients`,
`/professional/profile`, `/professional/referrals`, `/professional/schedule`, `/professional/tools`. Professional
mode carries its own bottom tabs (`design.md` §2a). Web sources under `src/pages/professional/*`.

0.4 Lane **`staff`** — the staff-mode screens (8 rows, all `not_started`):
`/staff/communications`, `/staff/dashboard`, `/staff/queue`, `/staff/reports`, `/staff/schedule`, `/staff/tasks`,
`/staff/time`, `/staff/tools`. Staff mode has **no bottom tabs** (`design.md` §2a). Web sources under
`src/pages/staff/*`.

0.5 Lane **`business`** — the business / commerce-mode screens (11 rows, all `not_started`; 10 `source: role-route`
+ 1 `source: exclusion`): **4 core commerce rows** — `/commerce`, `/commerce-login`, `/commerce/health-orders`,
`/commerce/health-orders/inbox` — **and 7 join / invite / connect / team / connections rows** —
`/commerce/connect`, `/commerce/connect/privacy`, `/commerce/connect/authorize` (the `source: exclusion` row this
lane flips), `/commerce/connections/:id`, `/commerce/invites/:token/accept`, `/commerce/join`, `/commerce/team`.
Business mode carries its own bottom tabs (`design.md` §2a). Web sources under `src/pages/` commerce screens. The
`business-mode.ts` / `drawer-nav.config.ts` / `role-switch-destination.ts` class-A modules (R1.5) back the
business-mode chrome.

## R1 — 1:1 parity with the mobile web screen

1.1 Each native screen mirrors the **mobile web** branch (the `useIsMobile()` ≤ 1024 px branch,
`src/hooks/use-mobile.tsx`) of its web source — same layout, same sections, same navigation, same wording. No
redesign, no added or removed section, no reordering (program §4 "Allowed native improvements only": platform
transitions, gestures, keyboard avoidance, safe areas, haptics, system sheets — nothing else).

1.2 Screens compose through the N3 shell and the N2 UI kit only: `MobileAppShell`, `TopAppBar`, `BottomNav`,
`MobileModePill`, bottom sheets, `VCard`, etc. come from `src/ports/*` (`apps/mobile/README.md` "Ports"); no web
component, no raw colour, every visual value from `@vitana/tokens`.

1.3 Web→native translation follows the README map exactly (`onClick`→`onPress`, `className`→`style`,
`toast`→`@vitana/ui/sonner`, documented `Select`/`Tooltip`/close-button/`Slider`/`Progress` differences). The four
web defects the N2 README lists are **not** reproduced — the native kit's corrected behaviour is used, and no web
file is touched.

1.4 **Bottom-tab parity by mode (`design.md` §2a).** Patient, professional and business modes each carry their own
bottom tabs (the mode's web tab bar, ported to the N3 `BottomNav`); **staff mode has no bottom tabs** (its web mode
has none) and the native staff screens render without a tab bar. A lane does not invent a tab bar a mode does not
have, and does not drop one a mode does.

1.5 Business logic, query keys, hooks, types and the role/mode helpers are reused from `@vitana/core`, never
re-implemented. **Class-A (core-extractable, pure, no `@/integrations/supabase/client`)** modules are extracted into
`@vitana/core`: `src/lib/business-mode.ts`, `src/config/drawer-nav.config.ts`, `src/lib/role-switch-destination.ts`.
Two of these are **already** in `packages/core/src/extracted/*.generated.ts` (`business-mode.generated.ts`,
`drawer-nav.generated.ts`) and `src/lib/permissions.ts` is **already** re-exported in
`packages/core/manifest.json`; the only new core extraction is `role-switch-destination.ts` (its imports are
type-only `UserRole` + the pure `getCommandHubUrl` config — class A). **Core extraction is class-A ONLY.** A new
core entry is added to `packages/core/manifest.json` with a re-export in the same lane PR and
`node scripts/native/core-closure.mjs --write` run (program §3). `@vitana/core` is the only web→native bridge;
ESLint bans `@/` and relative paths into web `src/` from app code.

1.6 **Class-B (re-implemented natively, NOT core-extracted)** data hooks — `usePatientAccess`, `useActivateReseller`,
`useResellerSales` and the other role data hooks — all import `@/integrations/supabase/client` (verified on
origin/main), so they are **not** moved into `@vitana/core` (they would fail `core-closure --check`). Each lane
re-implements its data fetching natively (native Supabase client + native auth context) and consumes only the
class-A helpers from core. (`apps/mobile/src/identity/usePatientAccess.ts` already exists as a native twin.)

## R2 — i18n (11 locales) + RTL

2.1 Every user-visible string (including `accessibilityLabel` / `accessibilityHint`) comes from the web catalog
shards `src/i18n/<locale>/*.json`, read through the generated catalog map — no hardcoded text (repo i18n hard rule;
`apps/mobile/README.md` "i18n").

2.2 All 11 active locales resolve: **de en es sr fr pl pt ru tr zh ar** (the live `supported_locales` table has all
11 `status='ga'`). A new key is added to the **German shard first** (`src/i18n/de/<role>Native.json`) then mirrored
to the other ten; **DE is du-form**. Register / form rules per locale: **pt is Brazilian você-form (NOT European
teu/tua), fr is tu-form (NOT vous), ru is ты-form (NOT вы)**; sr is ti-form; es is tú-form; **ar is right-to-left**.

2.3 Each screen works in RTL (`ar`): `start`/`end`, never `left`/`right`; the shell root `direction` follows the
language (`apps/mobile/README.md` N3 "Theme" row). A test scans the lane's files for physical `left`/`right`.

2.4 Adding a web i18n key is a web-deploy path. A lane that needs a genuinely new string adds the DE key first and
mirrors it to all ten others; a lane that can reuse an existing key does so and adds none. No existing web screen is
redesigned to add a key.

## R3 — React 19 / native typing

3.1 React 19 types: no global `JSX` namespace — use `ReactElement` (program hard rule; `.kiro/specs/health-native`
handoff "Hard rules"). `npm run typecheck` (which regenerates the i18n map first) is green.

## R4 — Parity ledger

4.1 Each lane flips its rows from `not_started` to `in_progress` while building and to `native` on completion by
running `node scripts/native/parity-ledger.mjs --sync` (status is edited by hand; `--sync` refreshes derived
fields), and NATIVE-CI `--check` is green: a `native` / `in_progress` row must have a matching route in
`apps/mobile/app/`, and no route in `app/` may lack a row (`scripts/native/parity-ledger.mjs` `check()`).

4.2 No lane changes `scope`/`lane`/`source` of a row (those come from `scripts/native/parity-scope.json`); no lane
edits another lane's rows. The four lanes touch disjoint sets of ledger rows, so the single `ledger.json` file is
the one shared path and conflicts resolve by row. The business lane is the only lane that flips the
`source: exclusion` row `/commerce/connect/authorize` (its scope stays `in`; only `status` changes).

## R5 — Verification and safety (never production)

5.1 Never test against production; staging specs are read-only (program §6; root `CLAUDE.md`). The native app has
**no production profile** and `assertNotProduction()` refuses the production gateway, `vitanaland.com`, the
production Supabase project and the staging hosts (`apps/mobile/README.md` "No production host, ever").

5.2 Build-time verification per lane is offline: `npm run typecheck`, `npm test` (jest-expo + RNTL unit tests with a
**fake gateway / fixtures**, no network), `APP_PROFILE=development npm run bundle` (Metro + Hermes JS for iOS and
Android), and `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` — all from `apps/mobile/`; plus
`node scripts/native/parity-ledger.mjs --check` and `node scripts/native/core-closure.mjs --check` from the repo
root. No live call is made.

5.3 Runtime parity verification (simulator / emulator screenshots, Maestro device journeys, screenshot parity vs the
390×844 web screen) is a **depends-on-owner (G1)** step: it needs the isolated test environment (and macOS minutes /
G3 for iOS on a device). Each such task is marked `next_actor: owner` in `tasks.md` and the lane records G1 as a
blocker in its log; it does not block the build-time port landing.

5.4 Each lane adds a read-only `docs/validation/<VTID>/staging-tests.json` for its screens (the VTID is written by CI
after PLAN-SPAR converges). Staging specs sign in, navigate and read; a network guard aborts every non-GET except
sign-in; never `vitanaland.com`.

5.5 No What's New entry (these are ports of existing screens, not new finished features — `CLAUDE.md` What's New
rule).

## R6 — Done

6.1 Every in-scope ledger row for the lane is `native` with its native route in `apps/mobile/app/` and its
functional-parity checklist (program §4 per-screen checklist) recorded; the mode's bottom-tab presence/absence
(R1.4) matches the web; RTL (`ar`) covered.

6.2 `npm run typecheck`, `npm test`, `npm run bundle`, `npm run deps:check`, `parity-ledger --check` and
`core-closure --check` green; NATIVE-CI (incl. the shell source-pin and ports checks) and the Collab handoff + Lane
scope PR-GATE checks green.

6.3 `docs/validation/<VTID>/` has `scope.json` (every touched path), `staging-tests.json` (the lane's read-only
spec) and `plan-sparring.md` (copy of this plan's sparring record).

## Out of scope (named so a lane does not drift into them)

- **ADMIN mode — all 93 `/admin/*` rows (every one `scope: out:system-browser`).** Admin is opened in an in-app
  system browser (SFSafariViewController on iOS, Custom Tabs on Android) per `NATIVE-APP-PLAN.md` §2 decisions 3/7;
  there is **no native port** of any admin screen. This plan touches no admin row.
- Class-B data hooks are **not** core-extracted (R1.6) — a lane that moves one into `@vitana/core` is a plan change.
- Any screen in another Wave 2 ledger lane (`home-feed`, `events-calendar`, `media`, `ai`, `discover-commerce`,
  `inbox-chat-calls`, etc.) — each is its own plan.
- G1 / G2 / G3 provisioning, EAS / store build pipelines, the ORB voice module — their own plans / owner gates.
- Any web-side change beyond adding an i18n key (DE first) and a `@vitana/core` class-A re-export line. No new route,
  no web redesign.
