# Plan — native-g1-wiring
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (native app `apps/mobile/`; one lane also edits
`.github/**`). Program: `docs/programs/native-app/NATIVE-APP-PLAN.md` (VTID-05021), Wave 1 exit (§5 row at
`:214`). Spec: `requirements.md`, `design.md`, `tasks.md`, `lanes/*.md` in this folder.

<!-- plan:begin -->
## Goal
Point dev/QA native builds at the G1 test backend via per-profile env + build profiles, and prove the
Wave 1 exit path — a signed-in member navigates the full shell, receives a push and opens its deep link —
on both platforms. Because the G1 isolated test backend is an owner-only gate that **does not exist yet**
(`vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md:95` §2a;
`vitana-platform:.kiro/specs/health-native/handoff.md:52` "Waiting on the owner" #4), the exit criterion
of this plan is the env/profile scaffolding **plus** a local **fixture-gateway** smoke that proves that
path offline. The one step that points a build at the **real** G1 is gated on the owner
(`real-g1-switch`, `next_actor: owner`) and never points any build at production or staging (both share
the production database — `vitana-platform:CLAUDE.md:606` (VTID-03506), "There is exactly one Supabase
project and every frontend (incl. preview/staging) writes to it". NB (R1-F1): cite this by **line 606**,
not by rule number — CLAUDE.md has two different "rule 31"s (the frontend-write rule at lines 599–611, and
the Bedrock-unconfigured rule at line 756); the single-Supabase fact is the former. Also stated in
`vitana-platform:.kiro/specs/health-native/handoff.md:100`; `vitana-v1:apps/mobile/src/config/env.ts:9`.

> **Repo note (R1-F1, R1-F2).** Every unqualified `file:line` in this plan is in **vitana-v1** unless
> prefixed `vitana-platform:`. This spec was authored into `vitana-platform` so PLAN-SPAR could fire, but
> the native code it premises on lives in `vitana-v1`, so the sparring partner cannot read those paths
> from a platform-only session. Resolving R1-F1 requires a governance change owned by Claude Code: either
> add `vitana-v1` as a pinned second checkout / `extra_ref` in `PLAN-SPAR.yml` so the partner can verify
> native `file:line` claims, or relocate this spec to `vitana-v1` and have the sparring call pass a
> vitana-v1 ref. Until that lands, the native `file:line` citations below are stated by the planner from a
> real read of vitana-v1 `origin/main` but are not independently partner-verifiable.

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
   `design.md §1`); only `native-ci-workflow` touches a governance path
   (`vitana-v1:.github/workflows/NATIVE-CI.yml` — R2-F3: created in **vitana-v1**, not vitana-platform;
   `.github/**` is a governance path in either repo) and is therefore `executor: claude`,
   `reviewer_seat: claude` (collaboration §3a). All other lanes are `executor: kiro`, `seat: exafyltd`,
   `reviewer_seat: hotmail`.
8. **`NATIVE-CI.yml` lives in `vitana-v1`, where `apps/mobile/` is** (R1-F6, R2-F1, R2-F2). A workflow in
   `vitana-platform` can never auto-trigger on a push to `apps/mobile/**` in `vitana-v1` — different
   repository — so a platform-side `on: push: paths: apps/mobile/**` is a dead letter (R2-F1). The native
   app's own CI therefore belongs in `vitana-v1:.github/workflows/NATIVE-CI.yml`: it triggers on
   `push`/`pull_request` filtered to `apps/mobile/**` **plus** `workflow_dispatch`, checks out vitana-v1
   (its own repo — no cross-repo checkout needed), and every step runs on `ubuntu-latest`
   (`cd apps/mobile && npm ci && npm test && APP_PROFILE=development npm run bundle`; offline Metro +
   jest-expo; no simulator, device, or macOS runner, so no macOS cost). It does not overlap
   `vitana-platform:.github/workflows/MOBILE-DEVICE-E2E.yml`, which is dispatch-only on macOS and runs the
   **web** frontend in an iOS Simulator via Safari — a different concern from bundling the native Expo JS.
   **`native-ci-workflow` is `executor: claude` / `reviewer_seat: claude` (R3-F1).** It edits
   `.github/workflows/NATIVE-CI.yml`, and the collaboration rule lists `.github/**` as a governance path
   **unqualified by repo** (`vitana-platform:.claude/rules/collaboration.md:100`) and states the rules file
   is identical in both repos (`:10`). So a `.github/workflows/**` edit in *either* repo is a governance
   change only a Claude Code (`executor: claude`) lane may make, which PR-GATE Lane scope enforces. (This
   corrects an earlier draft that wrongly flipped it to `executor: kiro` on a repo-scoped distinction the
   rule does not make; the relocation into vitana-v1 per R2-F1 stands — only the executor was wrong, and
   Decision 7 was right all along.) Its acceptance pins `runs-on: ubuntu-latest`.

## Lanes (all `ready`; no `vtid` until CI assigns it)
| Lane | Executor / seat → reviewer | Scope | depends_on | next_actor |
|---|---|---|---|---|
| `env-profiles` | kiro / exafyltd → hotmail | `apps/mobile/src/config/env.ts`, `apps/mobile/env/**`, `apps/mobile/tests/env*` | vitana-v1-verified | kiro |
| `eas-profiles` | kiro / exafyltd → hotmail | `apps/mobile/eas.json` | vitana-v1-verified, env-profiles | kiro |
| `native-ci-workflow` | **claude** / — → claude | `vitana-v1:.github/workflows/NATIVE-CI.yml` | vitana-v1-verified, eas-profiles | claude |
| `fixture-gateway` | kiro / exafyltd → hotmail | `tools/fixture-gateway/**`, `tests/fixture-gateway/**` (vitana-v1 repo root) | vitana-v1-verified | kiro |
| `deep-link-push-smoke` | kiro / exafyltd → hotmail | `apps/mobile/tests/g1-smoke/**`, `apps/mobile/src/push/g1-test-provider.ts` | vitana-v1-verified, env-profiles, fixture-gateway | kiro |
| `real-g1-switch` | kiro / exafyltd → hotmail | `apps/mobile/env/test-g1.g1.example.json`, `docs/validation/g1/**` | vitana-v1-verified, deep-link-push-smoke | **owner** |
| `spar-vitana-v1-ref` | **claude** / — → claude | `vitana-platform:.github/workflows/PLAN-SPAR.yml`, `vitana-platform:scripts/collab/plan-spar.mjs`, `vitana-platform:scripts/collab/plan-spar.test.mjs` | — | **done** (PR #4201, merged `fa73aabd0`) |
| `vitana-v1-verified` | **claude** / — → claude | `docs/validation/VTID-*/vitana-v1-spar-evidence.md` | spar-vitana-v1-ref | **claude** (sentinel: machine-enforces R1-F1) |

**The R1-F1 gate is machine-enforced by the `vitana-v1-verified` sentinel lane (R2-F2), not prose.** The
lane state machine has no `blocked` state, so a prose "approved→executing self-block" is advisory only and
every `ready` lane with no `depends_on` would be claimable the moment the plan converges. Instead, a
sentinel lane `vitana-v1-verified` (`executor: claude`) sits between `spar-vitana-v1-ref` and all
implementation lanes: **every implementation lane (`env-profiles`, `eas-profiles`, `native-ci-workflow`,
`fixture-gateway`, `deep-link-push-smoke`, `real-g1-switch`) has `vitana-v1-verified` in its `depends_on`**,
so the existing `depends_on` machinery (which the queue honours as `blocked`) keeps them un-claimable until
`vitana-v1-verified` is `done`. That lane's only job: a fresh PLAN-SPAR session has read `exafyltd/vitana-v1`
(a `tool_log` entry `read_file(repo: "exafyltd/vitana-v1")` with `ok: true`) and the plan converged on
partner-verified native premises; Claude Code records that evidence in
`docs/validation/<VTID>/vitana-v1-spar-evidence.md` and sets the lane `done`, which unblocks the rest. This
turns the gate into real `depends_on` enforcement instead of a prose promise.

**`spar-vitana-v1-ref` (R1-F1/R1-F2) — DONE, merged to main** (PR #4201, merge commit `fa73aabd0`; R2-F1:
the stale "still pending" paragraph is removed, one consistent status): `plan-spar.mjs` forwards
`extra_refs: { 'exafyltd/vitana-v1': <sha> }` and `PLAN-SPAR.yml` resolves the vitana-v1 `main` SHA, with a
test (`plan-spar.test.mjs` 10/10). The current session `185a911c` was created before the merge and stays
vitana-v1-blind; this plan-text change plus the current session reaching a terminal state opens a **fresh
session** whose base checkout contains the fix, so its `tool_log` can read `exafyltd/vitana-v1`. The
`approved→executing` self-block is lifted **once a fresh session's `tool_log` shows a successful
`read_file(repo: "exafyltd/vitana-v1", …)`** — the mechanical proof, not a mere merge. Until that fresh
session, the vitana-v1 `file:line` premises below are planner-read, not partner-verified.

Path ownership (R1-F3, R1-F4): no file is in two lanes and no in-scope file is orphaned. Paths that are
**not** under `apps/mobile/**`, listed explicitly:
- `fixture-gateway`: `tools/fixture-gateway/**`, `tests/fixture-gateway/**` are at the **vitana-v1 repo
  root** (mirroring `tools/orb-fake-gateway/`), not inside `apps/mobile/`.
- `deep-link-push-smoke`: its tests live under `apps/mobile/tests/g1-smoke/**` (inside `apps/mobile/`).
- `native-ci-workflow`: `vitana-v1:.github/workflows/NATIVE-CI.yml` — the native app's own CI, in
  vitana-v1 (R2-F1: a vitana-platform workflow can't trigger on vitana-v1 pushes). `.github/**` is a
  governance path in *either* repo (R3-F1), so this lane is `executor: claude`, `reviewer_seat: claude`.
- `real-g1-switch`: `docs/validation/g1/**` (vitana-v1 repo root).

**`build-profiles` is split into two lanes (R1-F4):** a cross-repo lane is illegal (one `branch:`/`pr:`
per lane). `eas-profiles` (`executor: kiro`, vitana-v1, `apps/mobile/eas.json`) and `native-ci-workflow`
(`executor: claude`, vitana-v1, `.github/workflows/NATIVE-CI.yml` — the native app's own CI, R2-F1;
`.github/**` is a governance path in either repo so it stays `executor: claude`, R3-F1) each get their own
branch/PR/VTID; `native-ci-workflow` depends on `eas-profiles`, which depends on `env-profiles`.

**Validation docs are in each lane's scope (R2-F1).** Every lane commits
`docs/validation/<VTID>/{scope.json,staging-tests.json,plan-sparring.md}` at the **vitana-v1 repo root**
(for the one vitana-platform lane, `native-ci-workflow`, at the platform repo root). This is NOT under
`apps/mobile/**` and NOT the `real-g1-switch` lane's G1-outcome dir `docs/validation/g1/**` — it is each
lane's own VTID dir. Every lane file's `paths:` therefore includes `docs/validation/VTID-*/scope.json`,
`.../staging-tests.json`, `.../plan-sparring.md` (a `VTID-*` glob because CI assigns the VTID after
convergence). The `real-g1-switch` lane carries both its G1-outcome glob and its own-VTID validation
globs. Added to the non-`apps/mobile` exceptions above: `docs/validation/VTID-*/**` for every lane.

**The vitana-v1 sparring ref is tracked as a `claude` lane (R1-F1), not a prose note.** The sparring
partner cannot read this plan's vitana-v1 `file:line` premises because the session is created pinned only
to `vitana-platform`. The fix is **two governance files, no gateway change** (the gateway already accepts
`extra_refs` and `github-tools.ts` already allowlists `exafyltd/vitana-v1`): `scripts/collab/plan-spar.mjs`
sends `extra_refs: { 'exafyltd/vitana-v1': <main SHA> }` in `client.create`, and
`.github/workflows/PLAN-SPAR.yml` resolves that SHA (`gh api repos/exafyltd/vitana-v1/commits/main --jq
.sha`) and passes it in. This is the `spar-vitana-v1-ref` lane (`executor: claude`), to land in one Claude
Code PR together with `plan(sparring-floor-retry)` #4186's `floor-retry-code` lane (both edit
`plan-spar.mjs`). **Refs pin at session creation**, so the current session cannot read vitana-v1 even after
the fix — a fresh session (a later plan-text push) is required for the ref to take effect. **This plan's
`approved→executing` is blocked until `spar-vitana-v1-ref` merges and the native plans re-spar in a new
session with the vitana-v1 ref live.** Only Claude Code can execute it (governance path).

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
  `vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md:233`). No What's New entry (configuration/test
  work, no new finished feature).

## Open owner items (not decided here)
- Provisioning G1 itself (owner, program §2a / handoff #4) — unblocks `real-g1-switch`.
- G2 push backend / Firebase project and the real FCM provider (N4-FCM) — unblocks real push on device.
- G3 store/signing + EAS cloud builds with credentials — the separate `native-eas-builds` plan.
<!-- plan:end -->
