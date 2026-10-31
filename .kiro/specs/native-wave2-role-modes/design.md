# Design — Native Wave 2: Role-mode screen ports (native-wave2-role-modes)

How the four lanes port the `role-modes` ledger cluster to native. Follows
`docs/programs/native-app/NATIVE-APP-PLAN.md` §2 (admin → in-app browser, decisions 3/7), §3 (architecture) and §4
(parity method), the N3 shell and N2 UI kit already on main, and `apps/mobile/README.md`. Nothing here changes the
program plan or the design contract.

## 1. Where native screens live and how they resolve

Wave 1 N3 (VTID-05186) built the shell and a resolver route: `apps/mobile/app/(app)/[...path].tsx` renders every
ledger destination that is not yet native as "Unported", admin as the web console (an in-app system browser, §2),
unknown as not-found. Porting a role screen means **adding its own Expo Router file under `apps/mobile/app/`** whose
route path equals the web path, so the resolver no longer catches it, the push `data.url` / universal link / ORB
directive resolve the same, and the parity row can go `native` (`scripts/native/parity-ledger.mjs` `fileToRoute()`
maps `app/(app)/patient/dashboard.tsx` → `/patient/dashboard`).

Route-file plan (Expo Router, paths = web paths):

| Lane | Native route file(s) under `apps/mobile/app/` | Web path(s) |
|---|---|---|
| `patient` | `(app)/patient/appointments.tsx`, `care-team.tsx`, `dashboard.tsx`, `goals.tsx`, `health.tsx`, `insurance.tsx`, `notifications.tsx`, `results.tsx` | `/patient/*` (8) |
| `professional` | `(app)/professional/billing.tsx`, `dashboard.tsx`, `education.tsx`, `patients.tsx`, `profile.tsx`, `referrals.tsx`, `schedule.tsx`, `tools.tsx` | `/professional/*` (8) |
| `staff` | `(app)/staff/communications.tsx`, `dashboard.tsx`, `queue.tsx`, `reports.tsx`, `schedule.tsx`, `tasks.tsx`, `time.tsx`, `tools.tsx` | `/staff/*` (8) |
| `business` | `(app)/commerce/index.tsx`, `(app)/commerce-login.tsx`, `(app)/commerce/connect/index.tsx`, `(app)/commerce/connect/privacy.tsx`, `(app)/commerce/connect/authorize.tsx`, `(app)/commerce/connections/[id].tsx`, `(app)/commerce/health-orders/index.tsx`, `(app)/commerce/health-orders/inbox.tsx`, `(app)/commerce/invites/[token]/accept.tsx`, `(app)/commerce/join.tsx`, `(app)/commerce/team.tsx` | `/commerce*` (11, incl. the `/commerce/connect/authorize` exclusion row) |

The ledger's shape-matching (`shapeOf`, query dropped) is satisfied by one file per route; dynamic segments
(`:id`, `:token`) map to Expo Router `[id]` / `[token]`.

## 2. Admin is NOT ported — in-app system browser only

The 93 `/admin/*` rows all carry `scope: out:system-browser` in the ledger (verified on origin/main). Per
`NATIVE-APP-PLAN.md` §2 decisions 3 and 7, admin is opened in an **in-app system browser**
(SFSafariViewController on iOS, Custom Tabs on Android), not reimplemented as native screens. The resolver route
already routes admin to the web console; **this plan adds no native admin route and touches no admin ledger row.**
Stated here and in `requirements.md` "Out of scope".

### 2a. Bottom tabs differ by mode

- **Patient, professional and business** modes each carry their own bottom tab bar — the web mode's tab bar ported
  to the N3 `BottomNav`. The lane wires the mode's tabs into the shell for its screens.
- **Staff mode has no bottom tabs** (its web mode has none). The native staff screens render on the N3 shell without
  a tab bar. The staff lane must not invent a tab bar.

The mode chrome (which tabs, the drawer, the role switch) is driven by the class-A helpers in §3 — `business-mode.ts`
for business, `drawer-nav.config.ts` for the drawer, `role-switch-destination.ts` for the post-switch landing — so
each mode's native chrome is computed from the same source of truth as the web, not hand-duplicated.

## 3. Screen source: the N2/N3 structure, not the web DOM; class split

Each lane re-implements the **mobile web** branch of its source screen with React Native primitives:

- Imports go through ports only: `@vitana/core/*` (hooks, query keys, role/mode helpers, types, registry),
  `@vitana/ui` (UI kit), `@vitana/tokens` (visual values), `src/ports/*` from the shell. No `@/…` web import
  (ESLint-banned in app code).
- The web→native prop map (`apps/mobile/README.md`) is mechanical: `onClick`→`onPress`, `className`→`style`,
  shadcn `Card`→`VCard`/`Panel`, `Dialog`/`Sheet`→the kit's modal / bottom sheet, `toast`/`notify*`→
  `@vitana/ui`/`@vitana/ui/sonner`, list/scroll→`FlatList`/`ScrollView`.

### 3a. Class-A core extraction (pure modules only)

The only web→native code bridge is `@vitana/core`. The role-mode chrome helpers are **class A** (pure, no
`@/integrations/supabase/client`, no `import.meta.env` / `localStorage`), so they are extracted into core and the
native screens consume them:

- `src/lib/business-mode.ts` — **already** in `packages/core/src/extracted/business-mode.generated.ts`.
- `src/config/drawer-nav.config.ts` — **already** in `packages/core/src/extracted/drawer-nav.generated.ts`.
- `src/lib/permissions.ts` — **already** re-exported in `packages/core/manifest.json` (reason: "Role/tenant switch
  permissions from the session; pure").
- `src/lib/role-switch-destination.ts` — the **only new** core extraction this plan needs. Its imports are the
  **type-only** `UserRole` (from `@/hooks/useRole`, excluded from the runtime graph by
  `scripts/native/extraction-deps.mjs`) and the pure `getCommandHubUrl` (`@/config/devHub.config`), so it is class A
  and passes `core-closure --check` after `--write`. The lane that needs it adds the manifest line + a re-export in
  `packages/core/src/**`, runs `node scripts/native/core-closure.mjs --write`, and commits the regenerated
  `packages/core/closure.generated.json` + `scripts/native/mobile-ci-paths.generated.json` **in the same PR** (the
  business lane owns this, §4 decision 3).

### 3b. Class-B native re-implementation (data hooks stay out of core)

The role **data** hooks — `usePatientAccess`, `useActivateReseller`, `useResellerSales` and the other per-role
fetchers — all runtime-import `@/integrations/supabase/client` (verified on origin/main:
`useResellerSales.ts`, `useActivateReseller.ts`, `usePatientAccess.ts`). That module is class B
(`import.meta.env` / `localStorage` / the prod Supabase URL), so moving a data hook into `@vitana/core` would pull
the client into the `core-closure.mjs` BFS and fail `--check`. Therefore **data fetching is re-implemented natively**
in each lane (native Supabase client + native auth context), consuming only the class-A helpers from core. A native
twin already exists for one of them (`apps/mobile/src/identity/usePatientAccess.ts`), and the patient lane reuses or
extends it rather than importing the web hook.

## 4. Decisions (made by Kiro as planner; sparring may revise)

1. **Four lanes, one per role mode.** The ledger groups all role screens in one `role-modes` lane; this plan
   partitions them by role prefix (`/patient/*`, `/professional/*`, `/staff/*`, `/commerce*`) into four lanes with
   disjoint native file subtrees (`app/(app)/<role>/**` + `src/screens/<role>/**`). Rationale: the four modes touch
   disjoint route files and components, build and review independently, and each leaves the app buildable. The
   partition is 8 / 8 / 8 / 11 = 35, 0 overlap, 0 orphan (verified against the ledger).
2. **Admin is not ported.** All 93 `/admin/*` rows are `scope: out:system-browser` — opened in an in-app system
   browser (§2). No native admin route, no admin ledger row touched.
3. **The `business` lane owns the only new class-A core extraction** (`role-switch-destination.ts`) and the
   `source: exclusion` row `/commerce/connect/authorize`. The business-mode chrome (tabs, drawer, role switch) leans
   on the already-extracted `business-mode` / `drawer-nav` and the newly extracted `role-switch-destination`. The
   business lane PR adds the manifest line + re-export, runs `core-closure.mjs --write`, and commits the regenerated
   generated files in the same PR. The other three lanes consume core but add no new core entry.
4. **Bottom tabs by mode (§2a):** patient / professional / business carry their own tabs; staff has none.
5. **Class-A-only core extraction; class-B data hooks re-implemented natively (§3a/§3b).**
6. **No new routes / registry / manifest.** These are ports of screens already in `App.tsx` + `screens.json`; a
   native Expo Router file is not an `App.tsx` route, so the registry / screen-manifest rule does not fire — only
   parity-row **status** flips.
7. **Runtime verification is deferred to G1** (owner gate). Lanes land the ports with offline build + fake-gateway
   unit tests green; the simulator / Maestro / screenshot-parity pass is a `next_actor: owner` task recorded in the
   lane and `staging-tests.json`. Matches the program's "fixture / fake-gateway tests only until G1" model.

## 5. Disjointness (no overlap, no orphan)

- **Ledger rows:** the 35 `role-modes` rows partition `patient` 8 + `professional` 8 + `staff` 8 + `business` 11 =
  35, 0 overlap, 0 orphan (verified with `node -e` over the origin/main ledger). Each row named explicitly in the
  lane file.
- **Native files:** each lane owns a disjoint subtree of `apps/mobile/app/(app)/<role>/` and
  `apps/mobile/src/screens/<role>/` (`<role>` = patient | professional | staff | business). No file is in two lanes.
- **Tests:** each lane owns `apps/mobile/tests/<role>/**` and its `docs/validation/<VTID>/` folder.
- **Shared, by-row-not-by-file:** `apps/mobile/parity/ledger.json` (each lane edits only its own rows),
  `packages/core/manifest.json` + `packages/core/src/**` + closure (only the business lane adds the one new class-A
  re-export), `scripts/native/mobile-ci-paths.generated.json`, and the DE-first i18n shards (each lane adds only its
  `<role>Native.json` keys). These are listed in each lane's `paths`.

## 6. Test design (per lane)

- **Unit (jest-expo + RNTL, fake gateway):** each screen renders its loaded state from fixture data, its empty
  state, its error state; the mode's bottom-tab presence/absence (§2a) is asserted; role-gated screens render the
  correct access state from fixtures (class-B hooks mocked). No network — the gateway/core hooks are mocked with
  fixtures.
- **i18n/RTL:** a test asserts no hardcoded user-visible string in the lane's screens and no physical `left`/`right`;
  renders one screen under `ar` (RTL) and asserts start/end; the register/form rules (R2.2: pt você, fr tu, ru ты)
  are satisfied by the shard content.
- **Typecheck/bundle/deps:** `npm run typecheck`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` from `apps/mobile/`.
- **Parity / core:** `node scripts/native/parity-ledger.mjs --check` and (business lane)
  `node scripts/native/core-closure.mjs --check` from the repo root (rows `native`, routes present, generated files
  current).
- **Deferred (G1, `next_actor: owner`):** Maestro journeys `apps/mobile/maestro/<role>/*.yaml`, iOS simulator +
  Android emulator screenshots at the device sizes, screenshot parity vs the 390×844 read-only staging web screen,
  listed in `docs/validation/<VTID>/staging-tests.json`.

## 7. Open items for the owner / sparring

- G1 isolated test environment (program gate) is required before any device-runtime parity check; until then the
  deferred tasks stay `next_actor: owner`.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- Whether any staff screen needs a native pattern not covered by the existing N2 kit (none expected; staff screens
  are list/detail/table shapes).
