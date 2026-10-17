# Plan — native-g1-wiring
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app `apps/mobile/`; one lane also edits
`.github/**`). Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), Wave 1 exit (§5 row at
`:214`). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this folder.

<!-- plan:begin -->
## Goal
Point dev/QA native builds at the G1 test backend via per-profile env + build profiles, and prove the
Wave 1 exit path — a signed-in member navigates the full shell, receives a push and opens its deep link —
on both platforms. Because the G1 isolated test backend is an owner-only gate that **does not exist yet**
(`docs/programs/native-app/NATIVE-APP-PLAN.md:95` §2a; `.kiro/specs/health-native/handoff.md:52`
"Waiting on the owner" #4), the exit criterion of this plan is the env/profile scaffolding **plus** a
local **fixture-gateway** smoke that proves that path offline. The one step that points a build at the
**real** G1 is gated on the owner (`real-g1-switch`, `next_actor: owner`) and never points any build at
production or staging (both share the production database — root `CLAUDE.md` "Why no host is exempt";
`apps/mobile/src/config/env.ts:9`).

## Measured state (origin/main, worktree `nat-g1-wiring-plan`)
- Parity ledger `apps/mobile/parity/ledger.json` v2: **435 route rows** — 428 `not_started`, 5
  `in_progress`, 2 `exception` — plus **15 shell entries** (all `in_progress`, owner `N3 VTID-05186`) and
  4 `native_only` entries (counted with `node -e` over the committed file).
- Wave 1 already on main: N3 shell (`apps/mobile/src/shell/`) and N2 UI kit (`apps/mobile/src/ui/`,
  `@vitana/ui`); the only non-`not_started` screen rows are the two member portals `/maxina` + `/alkalma`
  (`AUTH.MAXINA_PORTAL`/`AUTH.ALKALMA_PORTAL`, `in_progress`). Wave 2 screen ports have not started.
- Config/push/links scaffolding present: `src/config/{env,blocked-hosts,remote-config,http,kv-store,
  version}.ts`, `src/push/{provider,registration}.ts`, `src/linking/{resolve-link,link-router,auth-port}
  .ts`, `app.config.ts` (`APP_PROFILE` development/test-g1, `app.config.ts:36` throws on `production`).
  No `eas.json` exists yet.

## Decisions (each decided by Kiro, grounded in the cited code)
1. **Env source per profile = committed JSON under `apps/mobile/env/` + the existing guards**
   (`design.md §2`). `development.json` is empty (no network); `test-g1.example.json` holds G1
   **placeholder** hosts only. Reason: keeps `src/config/env.ts`'s production gate as the single
   authority (`env.ts:82`,`:105`,`:189`) and commits no real/secret endpoint. (Rejected: baking real G1
   URLs into the repo — forbidden by the never-production rule and premature since G1 doesn't exist.)
2. **Build-profile file = `apps/mobile/eas.json`, CI bundling stays offline Metro, no EAS cloud build**
   (`design.md §3`). Reason: `eas.json` is the standard Expo format the later `native-eas-builds` plan
   will extend, so defining `development`/`test-g1` now is forward-compatible at zero credential cost;
   cloud builds need G3 so they are out of scope here. (Rejected: a bespoke local profile file — thrown
   away when `eas.json` arrives anyway.)
3. **Fixture gateway is separate from the ORB fake** (`design.md §4`). The ORB fake
   (`tools/orb-fake-gateway/server.js:1`) only speaks the ORB WS/SSE voice protocol; the shell/push/
   deep-link path needs plain HTTP (`/api/v1/app-config`, `/auth/me`, `/notifications/token`, AASA/
   assetlinks). A new `tools/fixture-gateway/` mirrors the ORB fake's safety (loopback bind, listen-only)
   but answers that HTTP contract. (Rejected: extending the ORB fake — different protocol, would couple
   two unrelated harnesses.)
4. **Push proven with a test `PushProvider`, not FCM** (`design.md §5`). The port already supports
   injection (`src/push/provider.ts:52` `setPushProvider`); FCM waits for G2, so a `G1TestPushProvider`
   stands in and no Firebase package is added. The default stays `NoopPushProvider` (guarded by a test).
5. **The real-G1 switch is its own lane, `next_actor: owner`, with its own files** (`design.md §6`), so
   the four buildable lanes never block on the owner gate and the owner has one clear place to act.
6. **No new `app/` route, so no registry/manifest/parity change** (R6.5). This plan is config + tests +
   a dev-only fixture; the parity ledger, `screens.json`, `exclusions.json` and `screen-manifest` are
   untouched. If any lane needed a member-visible route it would add all four in that PR; none does.
7. **File ownership:** every file this plan touches belongs to exactly one lane (disjoint `paths`,
   `design.md §1`); only `build-profiles` touches a governance path (`.github/**`) and is therefore
   `executor: claude`, `reviewer_seat: claude` (collaboration §3a). All other lanes are `executor: kiro`,
   `seat: exafyltd`, `reviewer_seat: hotmail`.

## Lanes (all `ready`; no `vtid` until CI assigns it)
| Lane | Executor / seat → reviewer | Scope | depends_on | next_actor |
|---|---|---|---|---|
| `env-profiles` | kiro / exafyltd → hotmail | `src/config/env.ts`, `env/**`, `tests/env*` | — | kiro |
| `build-profiles` | **claude** / — → claude | `eas.json`, `.github/workflows/NATIVE-CI.yml` | env-profiles | claude |
| `fixture-gateway` | kiro / exafyltd → hotmail | `tools/fixture-gateway/**`, `tests/fixture-gateway/**` | — | kiro |
| `deep-link-push-smoke` | kiro / exafyltd → hotmail | `tests/g1-smoke/**`, `src/push/g1-test-provider.ts` | env-profiles, fixture-gateway | kiro |
| `real-g1-switch` | kiro / exafyltd → hotmail | `env/test-g1.g1.example.json`, `docs/validation/g1/**` | deep-link-push-smoke | **owner** |
All `paths` are under `apps/mobile/**` except `build-profiles` (`.github/**`) and `real-g1-switch`
(`docs/validation/g1/**`). A self-check confirms no file is in two lanes and no in-scope file is orphaned.

## Test plan
- Per lane (from `apps/mobile`): `npm ci`, `npm test` (jest-expo + RN Testing Library), `npm run
  typecheck`; the repo-root `node --test scripts/native/__tests__/` job and NATIVE-CI green; **Lane
  scope** green.
- `env-profiles`: `APP_PROFILE=development npm run bundle` and `APP_PROFILE=test-g1 npm run bundle` build
  offline; env suite covers development-empty, test-g1-placeholder, production-host-throws,
  missing-value-ConfigMissing.
- `build-profiles`: NATIVE-CI bundles both profiles offline (`EXPO_OFFLINE=1`), secret-free, and asserts
  the `test-g1` bundle has no production/staging host string.
- `fixture-gateway`: route-shape tests; `app-config` body passes `parseAppConfigResponse`; loopback-only
  bind enforced.
- `deep-link-push-smoke`: the fixture smoke proves navigate + push-tap deep-link + universal-link
  resolution offline; the default push provider stays Noop (guard test).
- `real-g1-switch`: no CI build until the owner provisions G1; verification is the smoke re-run against
  **real** G1 (both platforms) recorded in `docs/validation/g1/`.
- Each lane adds read-only `docs/validation/<VTID>/{scope.json,staging-tests.json,plan-sparring.md}`; no
  suite ever targets production or staging; staging specs read-only (program §6,
  `NATIVE-APP-PLAN.md:233`). No What's New entry (configuration/test work, no new finished feature).

## Open owner items (not decided here)
- Provisioning G1 itself (owner, program §2a / handoff #4) — unblocks `real-g1-switch`.
- G2 push backend / Firebase project and the real FCM provider (N4-FCM) — unblocks real push on device.
- G3 store/signing + EAS cloud builds with credentials — the separate `native-eas-builds` plan.
<!-- plan:end -->
