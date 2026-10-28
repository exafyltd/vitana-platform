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
  committed ledger. The 35 rows and their web paths are listed in `requirements.md` R0.2–R0.5.
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
- **Class split (verified by imports on origin/main):** **class-A core-extractable** = `src/lib/business-mode.ts`,
  `src/config/drawer-nav.config.ts`, `src/lib/role-switch-destination.ts`. `business-mode` and `drawer-nav` are
  ALREADY in `packages/core/src/extracted/*.generated.ts`; `src/lib/permissions.ts` is ALREADY re-exported in
  `packages/core/manifest.json`. `role-switch-destination.ts`'s imports are the type-only `UserRole` + the pure
  `getCommandHubUrl` config → class A, the only new core extraction. **class-B re-implemented natively** =
  `usePatientAccess`, `useActivateReseller`, `useResellerSales` and the other data hooks — all import
  `@/integrations/supabase/client` (verified), so they would fail `core-closure --check` and are NOT moved into
  core. **Core extraction is class-A ONLY.** A native `usePatientAccess` twin already exists at
  `apps/mobile/src/identity/usePatientAccess.ts`.
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
3. **Only class-A (pure) role-chrome modules move into `@vitana/core`; the data hooks do NOT.** The only new core
   extraction is `role-switch-destination.ts` (`business-mode` and `drawer-nav` are already extracted; `permissions`
   already re-exported). The data hooks (`usePatientAccess`, `useActivateReseller`, `useResellerSales`, …)
   runtime-import `@/integrations/supabase/client`, a class-B module, so a core entry would pull the client into the
   `core-closure.mjs` BFS and fail `--check` (`m.own !== 'A'`); each lane **re-implements the fetching natively**
   (native Supabase client + native auth context) and consumes only the class-A helpers from core. **The one core
   extraction is owned by the `business` lane** (its chrome needs `role-switch-destination`): the business PR adds
   the `packages/core/src/role-switch-destination.ts` re-export + the `packages/core/manifest.json` line, and **in
   the same PR** runs `node scripts/native/core-closure.mjs --write` and commits the regenerated
   `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json`, so `--check` passes.
   The other three lanes consume core but add no core entry.
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
   reproduced and no web file is touched beyond a DE-first i18n key and the one `@vitana/core` class-A re-export line.

## Lanes (all `ready`, executor kiro; seat → reviewer_seat; `vtid:` filled by CI on convergence)
| Lane | Seat → reviewer | Scope (web destinations) | depends_on |
|---|---|---|---|
| `patient` | exafyltd → hotmail | 8 `/patient/*` rows (appointments, care-team, dashboard, goals, health, insurance, notifications, results); own bottom tabs | — |
| `professional` | exafyltd → hotmail | 8 `/professional/*` rows (billing, dashboard, education, patients, profile, referrals, schedule, tools); own bottom tabs | — |
| `staff` | exafyltd → hotmail | 8 `/staff/*` rows (communications, dashboard, queue, reports, schedule, tasks, time, tools); **no bottom tabs** | — |
| `business` | exafyltd → hotmail | 11 commerce rows (4 core + 7 join/invite/connect/team/connections incl. the `/commerce/connect/authorize` exclusion row); own bottom tabs; **owns the one class-A core extraction** `role-switch-destination.ts` | — |
Exact `paths` globs are in each `lanes/<id>.md`; the 35 parity rows partition **8 (patient) + 8 (professional) +
8 (staff) + 11 (business)** with 0 overlap and 0 orphan. All four lanes are independent and run in parallel.

## Test plan
- **Per lane, offline (fixture / fake gateway, no network):** from `apps/mobile/` — `npm run typecheck`, `npm test`
  (jest-expo + RNTL: loaded/empty/error per screen; the mode's bottom-tab presence/absence asserted;
  role-gated access state from fixtures with class-B hooks mocked; i18n no-raw-text + RTL start/end; React 19
  `ReactElement`), `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check`. From the repo root —
  `node scripts/native/parity-ledger.mjs --check` (rows `native`, routes present).
- **Core extraction deliverable (business lane): run `--write` AND commit the generated files, not just `--check`.**
  The PR that adds the `role-switch-destination` re-export entry to `packages/core/src/` MUST also run
  `node scripts/native/core-closure.mjs --write` and commit the regenerated
  `packages/core/closure.generated.json` and `scripts/native/mobile-ci-paths.generated.json` in the SAME PR, then
  `node scripts/native/core-closure.mjs --check` passes. Without the `--write`+commit, `--check` fails in NATIVE-CI
  with "stale generated file". Class-A premise confirmed on origin/main (type-only `UserRole` import + pure
  `getCommandHubUrl`).
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
