# Tasks — Native Wave 2: Role-mode screen ports (patient / professional / staff / business)

Four lanes, disjoint `paths`, all independent (no `depends_on`). Design: `design.md` and `requirements.md` in this
folder are authoritative — follow them exactly; anything outside them is a plan change (log it, set
`next_actor: claude`). VTIDs are assigned by CI after PLAN-SPAR converges; do not start a lane before its `vtid:` is
set in `lanes/<id>.md`. All commands run from `apps/mobile/` unless noted; `assertNotProduction()` and the
no-production-profile rule make every command offline.

<!-- lane: patient -->
## Lane `patient` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports the 8 `/patient/*` rows (all `source: role-route`, all `not_started`): `/patient/appointments`,
`/patient/care-team`, `/patient/dashboard`, `/patient/goals`, `/patient/health`, `/patient/insurance`,
`/patient/notifications`, `/patient/results`. depends_on: none. Patient mode carries its own bottom tabs. Class-B
data hooks (`usePatientAccess` etc.) re-implemented natively (design §3b); a native `usePatientAccess` twin already
exists at `apps/mobile/src/identity/usePatientAccess.ts`.

- [ ] 1. Native patient screens on the N3 shell under `apps/mobile/app/(app)/patient/*` +
  `apps/mobile/src/screens/patient/**`: one Expo Router file per web path, mobile-web branch only, composed through
  N3/N2 with values from `@vitana/tokens`. Wire the patient bottom tabs into the shell (design §2a).
  Files: `apps/mobile/app/(app)/patient/**`, `apps/mobile/src/screens/patient/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Re-implement patient data fetching natively (native Supabase client + native auth), reusing/extending
  `apps/mobile/src/identity/usePatientAccess.ts`; consume only the class-A role helpers from `@vitana/core`. No web
  data hook imported, no data hook added to core (design §3b).
  Files: `apps/mobile/src/screens/patient/**`, `apps/mobile/src/ports/**`.
  Verify: `npm run typecheck`; `npm test` green.
- [ ] 3. i18n + RTL: user-visible strings from the web shards; any genuinely new key added to
  `src/i18n/de/patientNative.json` first, then the other ten (de en es sr fr pl pt ru tr zh ar) with the register
  rules (pt você, fr tu, ru ты, sr ti, es tú, ar RTL); render under `ar` with start/end only; no hardcoded text, no
  physical `left`/`right`.
  Files: `src/i18n/*/patientNative.json` (DE first), `apps/mobile/src/screens/patient/**`.
  Verify: `npm run typecheck`; `npm test` — no-raw-text / no-physical-direction tests pass.
- [ ] 4. Unit tests (fake gateway / fixtures, no network): each screen loaded / empty / error; patient bottom tabs
  present; role-gated access state from fixtures; React 19 `ReactElement`.
  Files: `apps/mobile/tests/patient/**`.
  Verify: `npm test` green; `APP_PROFILE=development npm run bundle` and
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the 8 parity rows to `native` and verify: `node scripts/native/parity-ledger.mjs --sync` (status
  edited by hand to `native`), then `--check`.
  Files: `apps/mobile/parity/ledger.json` (patient rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Device-runtime parity: Maestro
  `apps/mobile/maestro/patient/*.yaml`, iOS simulator + Android emulator screenshots, parity vs the 390×844 read-only
  staging patient screens. Blocked until G1 (+ macOS / G3 for iOS).
  Files: `apps/mobile/maestro/patient/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 7. PR: branch `kiro/native-wave2-role-modes/patient`, title
  `VTID-xxxxx (native-wave2-role-modes/patient): native patient-mode screen port`, body names the Kiro session id,
  Summary / Decisions taken / Tests / Handoff. Commit trailers `Collab-Session: <kiro id>`,
  `Collab-Lane: native-wave2-role-modes/patient`. Lane → `in-review`, `next_actor: kiro` (reviewer seat `hotmail`).
  Never merge, deploy or write to a live system (protocol §7a).

<!-- lane: professional -->
## Lane `professional` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports the 8 `/professional/*` rows (all `source: role-route`, all `not_started`): `/professional/billing`,
`/professional/dashboard`, `/professional/education`, `/professional/patients`, `/professional/profile`,
`/professional/referrals`, `/professional/schedule`, `/professional/tools`. depends_on: none. Professional mode
carries its own bottom tabs.

- [ ] 1. Native professional screens under `apps/mobile/app/(app)/professional/*` +
  `apps/mobile/src/screens/professional/**`: one Expo Router file per web path, mobile-web branch only, N3/N2
  composition, tokens only. Wire the professional bottom tabs (design §2a).
  Files: `apps/mobile/app/(app)/professional/**`, `apps/mobile/src/screens/professional/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Re-implement professional data fetching natively (native Supabase client + native auth); consume only the
  class-A role helpers from `@vitana/core`. No web data hook imported, no data hook added to core (design §3b).
  Files: `apps/mobile/src/screens/professional/**`, `apps/mobile/src/ports/**`.
  Verify: `npm run typecheck`; `npm test` green.
- [ ] 3. i18n + RTL (as patient task 3): new keys in `src/i18n/de/professionalNative.json` first, then the other ten;
  register rules (pt você, fr tu, ru ты); `ar` RTL start/end.
  Files: `src/i18n/*/professionalNative.json` (DE first), `apps/mobile/src/screens/professional/**`.
  Verify: `npm run typecheck`; `npm test` — no-raw-text / no-physical-direction pass.
- [ ] 4. Unit tests (fake gateway / fixtures): each screen loaded / empty / error; professional bottom tabs present;
  React 19 `ReactElement`.
  Files: `apps/mobile/tests/professional/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the 8 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (professional rows only),
  `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/professional/*.yaml` +
  sim/emulator screenshots + parity vs 390×844 staging. Blocked until G1 (+ macOS / G3 for iOS).
  Files: `apps/mobile/maestro/professional/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 7. PR: branch `kiro/native-wave2-role-modes/professional`, title
  `VTID-xxxxx (native-wave2-role-modes/professional): native professional-mode screen port`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-role-modes/professional`; lane → `in-review`, `next_actor: kiro`.
  No merge/deploy/live write.

<!-- lane: staff -->
## Lane `staff` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports the 8 `/staff/*` rows (all `source: role-route`, all `not_started`): `/staff/communications`,
`/staff/dashboard`, `/staff/queue`, `/staff/reports`, `/staff/schedule`, `/staff/tasks`, `/staff/time`,
`/staff/tools`. depends_on: none. **Staff mode has NO bottom tabs** (design §2a) — do not add a tab bar.

- [ ] 1. Native staff screens under `apps/mobile/app/(app)/staff/*` + `apps/mobile/src/screens/staff/**`: one Expo
  Router file per web path, mobile-web branch only, N3/N2 composition, tokens only. **No bottom tab bar** — the staff
  mode has none (design §2a).
  Files: `apps/mobile/app/(app)/staff/**`, `apps/mobile/src/screens/staff/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 2. Re-implement staff data fetching natively (native Supabase client + native auth); consume only the class-A
  role helpers from `@vitana/core`. No web data hook imported, no data hook added to core (design §3b).
  Files: `apps/mobile/src/screens/staff/**`, `apps/mobile/src/ports/**`.
  Verify: `npm run typecheck`; `npm test` green.
- [ ] 3. i18n + RTL (as patient task 3): new keys in `src/i18n/de/staffNative.json` first, then the other ten;
  register rules (pt você, fr tu, ru ты); `ar` RTL start/end.
  Files: `src/i18n/*/staffNative.json` (DE first), `apps/mobile/src/screens/staff/**`.
  Verify: `npm run typecheck`; `npm test` — no-raw-text / no-physical-direction pass.
- [ ] 4. Unit tests (fake gateway / fixtures): each screen loaded / empty / error; assert **no bottom tab bar** is
  rendered for staff mode; React 19 `ReactElement`.
  Files: `apps/mobile/tests/staff/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 5. Flip the 8 parity rows to `native`; `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (staff rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 6. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/staff/*.yaml` +
  sim/emulator screenshots + parity vs 390×844 staging. Blocked until G1 (+ macOS / G3 for iOS).
  Files: `apps/mobile/maestro/staff/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 7. PR: branch `kiro/native-wave2-role-modes/staff`, title
  `VTID-xxxxx (native-wave2-role-modes/staff): native staff-mode screen port`; trailers `Collab-Session`,
  `Collab-Lane: native-wave2-role-modes/staff`; lane → `in-review`, `next_actor: kiro`. No merge/deploy/live write.

<!-- lane: business -->
## Lane `business` · executor Kiro · seat exafyltd → reviewer_seat hotmail
Ports the 11 commerce rows (10 `source: role-route` + 1 `source: exclusion`, all `not_started`): **4 core** —
`/commerce`, `/commerce-login`, `/commerce/health-orders`, `/commerce/health-orders/inbox`; **7 join/invite/connect
/team/connections** — `/commerce/connect`, `/commerce/connect/privacy`, `/commerce/connect/authorize` (the
`source: exclusion` row this lane flips), `/commerce/connections/:id`, `/commerce/invites/:token/accept`,
`/commerce/join`, `/commerce/team`. depends_on: none. Business mode carries its own bottom tabs. **This lane owns the
only new class-A core extraction** (`role-switch-destination.ts`, design §3a / decision 3). Class-B commerce data
hooks (`useActivateReseller`, `useResellerSales`) re-implemented natively (design §3b).

- [ ] 1. Core extraction (class-A only): add `src/lib/role-switch-destination.ts` to `packages/core/manifest.json`
  with a re-export in `packages/core/src/**`, then `node scripts/native/core-closure.mjs --write` and commit the
  regenerated `packages/core/closure.generated.json` + `scripts/native/mobile-ci-paths.generated.json` **in this
  PR**. `business-mode.ts` / `drawer-nav.config.ts` are already extracted and `permissions.ts` already re-exported —
  no new entry for those. Do NOT add any class-B data hook to core.
  Files: `packages/core/manifest.json`, `packages/core/src/**`, `packages/core/closure.generated.json`,
  `packages/core/extract.json`, `scripts/native/mobile-ci-paths.generated.json`.
  Verify (repo root): `node scripts/native/core-closure.mjs --check` passes; `apps/mobile` → `npm run typecheck`
  green.
- [ ] 2. Native commerce screens under `apps/mobile/app/(app)/commerce/**` + `apps/mobile/app/(app)/commerce-login.tsx`
  + `apps/mobile/src/screens/business/**`: one Expo Router file per web path (dynamic `[id]`, `[token]` segments),
  mobile-web branch only, N3/N2 composition, tokens only. Wire the business bottom tabs via the core `business-mode`
  / `drawer-nav` helpers and the role switch via `role-switch-destination` (design §2a/§3a).
  Files: `apps/mobile/app/(app)/commerce/**`, `apps/mobile/app/(app)/commerce-login.tsx`,
  `apps/mobile/src/screens/business/**`.
  Verify: `npm test` + `npm run typecheck` green.
- [ ] 3. Re-implement commerce data fetching natively (`useActivateReseller` / `useResellerSales` twins; native
  Supabase client + native auth); consume only the class-A helpers from core. No web data hook imported, no data
  hook added to core (design §3b).
  Files: `apps/mobile/src/screens/business/**`, `apps/mobile/src/ports/**`.
  Verify: `npm run typecheck`; `npm test` green.
- [ ] 4. i18n + RTL (as patient task 3): new keys in `src/i18n/de/businessNative.json` first, then the other ten;
  register rules (pt você, fr tu, ru ты); `ar` RTL start/end.
  Files: `src/i18n/*/businessNative.json` (DE first), `apps/mobile/src/screens/business/**`.
  Verify: `npm run typecheck`; `npm test` — no-raw-text / no-physical-direction pass.
- [ ] 5. Unit tests (fake gateway / fixtures): each screen loaded / empty / error; business bottom tabs present; the
  connect/authorize and invite/accept flows resolve the right screen from a deep link; `role-switch-destination`
  core helper unit test; React 19 `ReactElement`.
  Files: `apps/mobile/tests/business/**`.
  Verify: `npm test`; `APP_PROFILE=development npm run bundle`;
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green.
- [ ] 6. Flip all 11 parity rows to `native` (including the `source: exclusion` row `/commerce/connect/authorize` —
  only its `status` changes, `scope` stays `in`); `--sync` then `--check`.
  Files: `apps/mobile/parity/ledger.json` (business rows only), `docs/validation/<VTID>/{scope,staging-tests}.json`.
  Verify (repo root): `node scripts/native/parity-ledger.mjs --check` green.
- [ ] 7. **(depends-on-owner / G1 — `next_actor: owner`)** Maestro `apps/mobile/maestro/business/*.yaml` +
  sim/emulator screenshots + parity vs 390×844 staging. Blocked until G1 (+ macOS / G3 for iOS).
  Files: `apps/mobile/maestro/business/**`, `docs/validation/<VTID>/staging-tests.json`.
- [ ] 8. PR: branch `kiro/native-wave2-role-modes/business`, title
  `VTID-xxxxx (native-wave2-role-modes/business): native business/commerce-mode screen port`; trailers
  `Collab-Session`, `Collab-Lane: native-wave2-role-modes/business`; lane → `in-review`, `next_actor: kiro`.
  No merge/deploy/live write.

## Acceptance (every lane; the reviewer seat checks these)
- Requirements R1–R6 met for the lane's screens; mobile-web parity, N2/N3 composition, `@vitana/core`-only bridge;
  the mode's bottom-tab presence/absence (R1.4 / design §2a) matches the web.
- `npm run typecheck`, `npm test`, `APP_PROFILE=development npm run bundle`,
  `APP_PROFILE=development EXPO_OFFLINE=1 npm run deps:check` green; `node scripts/native/parity-ledger.mjs --check`
  green with the lane's rows `native`; `node scripts/native/core-closure.mjs --check` green (business lane's
  extraction current).
- 11 locales (de en es sr fr pl pt ru tr zh ar), DE-first new keys, register rules (pt você, fr tu, ru ты), RTL
  (`ar`) covered; no hardcoded user-visible text; no physical `left`/`right`.
- NATIVE-CI (shell source-pin + ports), PR-GATE **Collab handoff** and **Lane scope** green.
- `docs/validation/<VTID>/` has `scope.json`, `staging-tests.json` (read-only) and `plan-sparring.md`.
- Device-runtime parity (the last task) is deferred to G1 as `next_actor: owner`; not a merge blocker for the port,
  recorded in the lane log and `staging-tests.json`.
- ADMIN is out of scope — no lane touches any `/admin/*` row (all `scope: out:system-browser`, design §2).
- Never: VTID allocation, merge/approve, workflow dispatch, deploy, Supabase/AWS writes, or any test against
  production (protocol §7a; program §6).
