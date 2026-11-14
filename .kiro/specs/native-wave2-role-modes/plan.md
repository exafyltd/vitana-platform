# Plan — native-wave2-role-modes
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app only — `apps/mobile/**`, `packages/core/**`
via the manifest/closure process, `apps/mobile/parity/ledger.json`, DE-first i18n shards, `docs/validation/**`; no
backend, no gateway change, no migration). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this
folder. Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), §5 Wave 2. Frontend repo for sparring
re-verification is forwarded via `handoff.md` `spar_refs: exafyltd/vitana-v1: main`.

<!-- plan:begin -->
## Goal
Wave 2 role-mode screen-port batch of the native Maxina app: port the role-mode web screens the parity ledger
assigns to `"lane": "role-modes"` — the patient, professional, staff and business (commerce) mode screens — to the
native app (`apps/mobile/`) at 1:1 parity with today's **mobile web** screens, built on `@vitana/core` +
`@vitana/tokens` + the N2 UI kit (`@vitana/ui`) on the Wave 1 N3 shell, with fixture / fake-gateway unit tests. Does
**not** need G1 planned or built to land the ports; every device-runtime verification step is marked
depends-on-owner (G1). No redesign (program §4), no new web screen, no `App.tsx` route, no registry/manifest change
— only native route files and parity-row status flips. **ADMIN is not ported** (program §2 decisions 3/7 —
in-app system browser).

## Measured state (frontend repo `exafyltd/vitana-v1` origin/main, parity ledger `apps/mobile/parity/ledger.json` version 2)
- **35 rows** carry `"lane": "role-modes"`, **all `status: "not_started"`** (34 `source: role-route`, 1
  `source: exclusion` — `/commerce/connect/authorize`); **435 rows total**. Counted with `node -e` over the
  committed ledger. **R1-F2 confirmation:** the `/commerce/connect/authorize` row DOES exist — it sits in the
  **exclusion section** of the ledger (around `apps/mobile/parity/ledger.json:2477`), NOT in the `role-route`
  commerce block at `:4337-4455` the partner read, which is why its budget-limited read found only the 10 role-route
  commerce rows. The exclusion row is `"lane": "role-modes"`, `"source": "exclusion"`, `"status": "not_started"`
  (verified with `node -e`: 11 commerce `role-modes` rows total = 10 role-route + 1 exclusion). The 8+8+8+11 = 35
  partition is therefore correct. The 35 rows and their web paths are listed in `requirements.md` R0.2–R0.5.
- **Partition by role prefix into 4 disjoint lanes: patient 8 + professional 8 + staff 8 + business 11 = 35**,
  **0 overlap, 0 orphan** (verified with `node -e`: every row classified by `web_path.startsWith('/patient/' |
  '/professional/' | '/staff/' | '/commerce')`). Native file subtrees are disjoint
  (`app/(app)/<role>/**` + `src/screens/<role>/**` per lane). Business = 4 core commerce rows
  (`/commerce`, `/commerce-login`, `/commerce/health-orders`, `/commerce/health-orders/inbox`) + 7
  join/invite/connect/team/connections rows (`/commerce/connect`, `/commerce/connect/privacy`,
  `/commerce/connect/authorize`, `/commerce/connections/:id`, `/commerce/invites/:token/accept`, `/commerce/join`,
  `/commerce/team`), and is the lane that flips the one `source: exclusion` row.
- **ADMIN excluded:** 93 `/admin/*` rows, every one `scope: out:system-browser` (verified). Admin is opened in an
  in-app system browser (SFSafariViewController / Custom Tabs) per `NATIVE-APP-PLAN.md` §2 decisions 3/7; no native
  port. Stated in `requirements.md` "Out of scope" and `design.md` §2.
- **Class split (verified by imports on origin/main):** **class-A, ALREADY in core** = `src/lib/business-mode.ts`
  and `src/config/drawer-nav.config.ts` (already in `packages/core/src/extracted/*.generated.ts`); `src/lib/permissions.ts`
  is ALREADY re-exported in `packages/core/manifest.json`. **No NEW core extraction is needed by this plan**
  (corrected per sparring R1-F1 — see next bullet). **`role-switch-destination.ts` is NOT class A and is NOT
  extracted:** it value-imports `getCommandHubUrl` from `src/config/devHub.config.ts` (a **value** import, not
  type-only — `role-switch-destination.ts:2`), and `devHub.config.ts` reads `import.meta.env.VITE_DEV_HUB_ENABLED`
  / `VITE_DEV_HUB_READONLY` / `VITE_GATEWAY_BASE` (`:8-12`), which the extraction tooling marks as a `vite` signal →
  own-class **B** (`extraction-deps.mjs:207-211`, `:231-233`). The `core-closure.mjs` BFS (`:145-156`) would traverse
  the non-type-only edge into `devHub.config.ts`, find `m.own !== 'A'`, and **fail `--check`**. So
  `role-switch-destination.ts` is re-implemented natively in the `business` lane (option (c)), alongside the data
  hooks — the business lane's role-switch destination mapping is a small native helper (it may take the
  command-hub URL as an injected value rather than importing `devHub.config.ts`), not a core re-export. **class-B
  re-implemented natively** = `usePatientAccess`, `useActivateReseller`, `useResellerSales` and the other data hooks
  — all import `@/integrations/supabase/client` (verified), so they would fail `core-closure --check` and are NOT
  moved into core. **This plan adds NO new `@vitana/core` entry at all.** A native `usePatientAccess` twin already
  exists at `apps/mobile/src/identity/usePatientAccess.ts`.
- Wave 1 is on main: N3 shell + resolver route (`apps/mobile/app/(app)/[...path].tsx`, VTID-05186), N2 UI kit
  (`@vitana/ui`, VTID-05176), N1 `@vitana/core`/`@vitana/tokens` (VTID-05183). Prop map, ports and conventions in
  `apps/mobile/README.md`. The native app has no production profile; `assertNotProduction()` refuses prod/staging
  hosts.

## Decisions (made by Kiro as planner under the owner's "finish the native apps" instruction; sparring may revise)
1. **Four disjoint lanes by role prefix.** The ledger groups all role screens in one `role-modes` lane; this plan
   partitions them into `patient` (8), `professional` (8), `staff` (8) and `business` (11) by `/patient/*`,
   `/professional/*`, `/staff/*`, `/commerce*`. The four touch disjoint route files and component folders
   (`src/screens/<role>/`), build/review independently, and each leaves the app buildable. 8+8+8+11 = 35, 0 overlap,
   0 orphan (re-verified against the ledger). **All four are independent — no `depends_on` — and run in parallel.**
2. **ADMIN is not ported.** All 93 `/admin/*` rows are `scope: out:system-browser` — opened in an in-app system
   browser (program §2 decisions 3/7). No native admin route, no admin ledger row touched by this plan.
3. **Only already-extracted class-A role-chrome modules are consumed from `@vitana/core`; this plan adds NO new core
   entry** (corrected per sparring R1-F1). `business-mode` and `drawer-nav` are already in core and `permissions` is
   already re-exported — the lanes consume those as-is. **`role-switch-destination.ts` is NOT extracted:** it is
   class B through its value import of `getCommandHubUrl` → `devHub.config.ts`'s `import.meta.env` reads, so a core
   entry would fail `core-closure --check` (measured state above). The `business` lane **re-implements the
   role-switch destination mapping natively** (option (c)) — a small native helper that takes the command-hub URL as
   an injected value instead of importing `devHub.config.ts` — exactly as it re-implements the data hooks. The data
   hooks (`usePatientAccess`, `useActivateReseller`, `useResellerSales`, …) runtime-import
   `@/integrations/supabase/client`, a class-B module, so each lane **re-implements the fetching natively** (native
   Supabase client + native auth context) and consumes only the already-present class-A helpers from core. **No lane
   adds a `packages/core/src/**` re-export or a `manifest.json` line, and no lane runs `core-closure.mjs --write`**
   — the generated files are unchanged, so `--check` passes as-is.
4. **Bottom tabs differ by mode.** Patient, professional and business modes each carry their own bottom tabs (the
   web mode's tab bar ported to the N3 `BottomNav`); **staff mode has no bottom tabs** (its web mode has none) and
   the native staff screens render without a tab bar. A lane does not invent or drop a mode's tab bar.
5. **No new routes / registry / manifest.** Ports of screens already in `App.tsx` + `screens.json`; a native Expo
   Router file is not an `App.tsx` route, so the "new page needs screens.json/exclusions.json + screen-manifest +
   parity rows" rule does not fire — only parity-row **status** flips (`not_started`→`in_progress`→`native`). The
   business lane's flip of `/commerce/connect/authorize` changes only that exclusion row's `status`; its `scope`
   stays `in`.
6. **Device-runtime verification deferred to G1** (owner gate). Lanes land with offline build + fake-gateway unit
   tests green; the Maestro / simulator / screenshot-parity pass is a `next_actor: owner` task recorded in the lane
   and `staging-tests.json`. Matches the program's "fixture / fake-gateway tests only until G1" model.
7. **Mobile-web parity, not desktop.** Each native screen mirrors the `useIsMobile()` ≤ 1024 px branch of its
   source, composed through N3/N2, every visual value from `@vitana/tokens`; the N2-documented web defects are not
   reproduced and no web file is touched beyond a DE-first i18n key (no `@vitana/core` re-export line is added — this
   plan extracts nothing new, decision 3).

## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `patient` | exafyltd → hotmail | 8 `/patient/*` rows (appointments, care-team, dashboard, goals, health, insurance, notifications, results); own bottom tabs | — |
| `professional` | exafyltd → hotmail | 8 `/professional/*` rows (billing, dashboard, education, patients, profile, referrals, schedule, tools); own bottom tabs | — |
| `staff` | exafyltd → hotmail | 8 `/staff/*` rows (communications, dashboard, queue, reports, schedule, tasks, time, tools); **no bottom tabs** | — |
| `business` | exafyltd → hotmail | 11 commerce rows (4 core + 7 join/invite/connect/team/connections incl. the `/commerce/connect/authorize` exclusion row); own bottom tabs; **re-implements `role-switch-destination` natively** (not a core extraction — class B via `devHub.config.ts`, sparring R1-F1) | — |
Exact `paths` globs are in each `lanes/<id>.md`; the 35 parity rows partition **8 (patient) + 8 (professional) +
8 (staff) + 11 (business)** with 0 overlap and 0 orphan. All four lanes are independent and run in parallel.

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; the mode's bottom-tab presence/absence asserted;
  role-gated access state from fixtures with class-B hooks mocked; i18n no-raw-text + RTL start/end; React 19
  `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **No new core extraction (corrected per sparring R1-F1).** This plan adds no `packages/core/src/**` re-export and
  no `manifest.json` line, so no lane runs `core-closure.mjs --write`; the generated files
  (`packages/core/closure.generated.json`, `scripts/native/mobile-ci-paths.generated.json`) are unchanged and
  `node scripts/native/core-closure.mjs --check` passes as-is. `role-switch-destination.ts` is NOT extracted (it is
  class B through `devHub.config.ts`'s `import.meta.env` reads, verified on origin/main) — the `business` lane
  re-implements its mapping natively. `business-mode`/`drawer-nav`/`permissions` are already in core and are consumed
  unchanged.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** + **Lane scope** green.
- **i18n:** 11 locales (de en es sr fr pl pt ru tr zh ar), any new key DE-first (du-form) then mirrored; register /
  form rules — **pt Brazilian você (not teu/tua), fr tu (not vous), ru ты (not вы)**, sr ti, es tú; RTL (`ar`)
  rendered per screen.
- **Deferred to G1 (owner gate, `next_actor: owner`):** Maestro `maestro/<role>/*.yaml`, iOS simulator + Android
  emulator screenshots at the device sizes, screenshot parity vs the 390×844 **read-only** staging web screen; listed
  in `docs/validation/<VTID>/staging-tests.json` (sign in, navigate, read; network guard aborts every non-GET except
  sign-in; never `vitanaland.com`). STAGING-VERIFY is read-only by construction (program §6).
- **No What's New entry** (ports of existing screens). No new routes → no nav-registry change and no new native
  parity row — only status flips.

## Open owner / sparring items (not decided here)
- G1 isolated test environment (program gate) — required before any device-runtime parity check; the deferred tasks
  stay `next_actor: owner` until it exists.
- macOS minutes / G3 for iOS-on-device screenshots (program STATUS row 8b) — not needed for the JS build.
- Whether any staff screen needs a native pattern not already in the N2 kit (none expected — list/detail/table
  shapes).

## Re-authoring note (2026-10-28)
This spec was authored and reviewer-approved earlier, then its six files were LOST: a `git worktree add` timed out on
Windows and left broken reparse-point stubs for the spec files, which were pruned, and the
`kiro/native-wave2-role-modes/plan` branch carried no spec commits (only `spec-review.json` / `spec-review.md` were
expected to survive and were not found in either checkout either). Re-created cleanly here from the known-correct
decomposition, re-verified against `exafyltd/vitana-v1` `origin/main` `apps/mobile/parity/ledger.json`, mirroring the
sibling spec `native-wave2-home-feed-news` structure exactly. No VTID allocated (CI PLAN-SPAR allocates lane VTIDs on
convergence); no app code written; no live system touched. PLAN-SPAR is live on main (commit `55cc5bbadc`) and the
`spar_refs` entry lets the partner read the frontend repo to verify these premises.
<!-- plan:end -->
