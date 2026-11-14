# VTID-05767 — Acceptance (autonomous-to-staging / pipeline-b-v1)

Plan: `exafyltd/vitana-platform:.kiro/specs/autonomous-to-staging/plan.md` §3.2 "Pipeline B everywhere (H10)"; tasks.md
group `<!-- lane: pipeline-b-v1 -->` (T1, T2). Change types: Tooling/docs. Deploys nothing (CI-only PR-GATE classifier).

## What changed
- `scripts/ci/pr-gate/lib.mjs`: `FRONTEND_SIMPLE_ALLOW` gains `apps/mobile/src/**`. `FRONTEND_SIMPLE_DENY` gains the
  native surfaces that stay sparred: `apps/mobile/src/navigation/**`, `apps/mobile/src/linking/**`,
  `apps/mobile/src/shell/**`, `apps/mobile/src/auth/**`, `apps/mobile/src/config/**`, `apps/mobile/src/ports/**`,
  `apps/mobile/src/**/*.generated.*`, `apps/mobile/src/**/.generated/**`, `apps/mobile/parity/**`,
  `apps/mobile/app.json`, `apps/mobile/app.config.ts`, `apps/mobile/eas.json`. Web entries are unchanged.
  `frontendSimpleViolations` itself is unchanged.
- `scripts/ci/pr-gate/__tests__/frontend-simple-mobile.test.mjs` (new): fixtures for each surface (T2).
- `scripts/ci/pr-gate/__tests__/frontend-simple.test.mjs`: the one fixture `apps/mobile/src/x.tsx` in "back-end, schema,
  CI and config changes do not qualify" asserted the old contract (native screen code outside the class). It is replaced
  by `apps/mobile/app.json`, still outside the class. Same number of cases and assertions.
- NATIVE-CI (`.github/workflows/NATIVE-CI.yml`) is not touched: it still triggers on `apps/mobile/**` and runs the
  parity ledger and shell-pin checks, so native changes in the class are still checked by it.

## Acceptance criteria → tests

AC-1 — T1: a change in `apps/mobile/src/**` screen code (screens, ui, theme, orb) qualifies as frontend-simple.
TEST: scripts/ci/pr-gate/__tests__/frontend-simple-mobile.test.mjs ("a native screen change in apps/mobile/src qualifies (VTID-05767)")

AC-2 — T1: a web change and its native twin qualify together.
TEST: scripts/ci/pr-gate/__tests__/frontend-simple-mobile.test.mjs ("a web change and its native twin qualify together (VTID-05767)")

AC-3 — T1: native navigation (and deep-link routing, shell, auth, config, core ports) is denied.
TEST: scripts/ci/pr-gate/__tests__/frontend-simple-mobile.test.mjs ("native navigation, linking, shell, auth, config and ports need sparring (VTID-05767)")

AC-4 — T1: `apps/mobile/parity/**`, `app.json`, `eas.json`, `app.config.ts` and generated files are denied.
TEST: scripts/ci/pr-gate/__tests__/frontend-simple-mobile.test.mjs ("parity ledger, app.json, eas.json, app config and generated files need sparring (VTID-05767)")
TEST: scripts/ci/pr-gate/__tests__/frontend-simple-mobile.test.mjs ("the deny list names the native surfaces explicitly (VTID-05767)")

AC-5 — Nothing else under `apps/mobile/` (Expo Router `app/`, package files, native modules, tests, maestro) or `packages/` enters the class.
TEST: scripts/ci/pr-gate/__tests__/frontend-simple-mobile.test.mjs ("everything else under apps/mobile stays outside the class (VTID-05767)")

AC-6 — T2: existing web surfaces are unchanged (allowed and denied fixtures).
TEST: scripts/ci/pr-gate/__tests__/frontend-simple-mobile.test.mjs ("existing web surfaces are unchanged (VTID-05767)")
TEST: scripts/ci/pr-gate/__tests__/frontend-simple.test.mjs ("deny-listed front-end files (routes, navigation, auth, integrations) need sparring")

AC-7 — Acceptance: NATIVE-CI and parity checks stay required for native changes.
TEST: scripts/ci/pr-gate/__tests__/frontend-simple-mobile.test.mjs ("NATIVE-CI and its parity checks still run on every apps/mobile change (VTID-05767)")

AC-8 — The new behaviour fails on base `96d43e09f457f543b443c66e333f4837fb82eebb`.
TEST: docs/validation/VTID-05767/outputs/red-on-base.txt ("3 of 15 fail on base: AC-1, AC-2, AC-4 deny-list test")

## Results
- Red on base (`96d43e09f457f543b443c66e333f4837fb82eebb`, lib.mjs unchanged): `outputs/red-on-base.txt` — 15 tests, 12 pass, 3 fail.
- Green on head: `outputs/green.txt` — 15 tests, 15 pass, 0 fail.
- Full PR-gate suite `npm run test:gate` on head: `outputs/test-gate.txt` — 43 tests, 43 pass, 0 fail (base: 43, 40 pass, 3 fail).

## Decisions taken
- The plan says "deny native navigation". The native routing lives in `apps/mobile/src/navigation/` and
  `apps/mobile/src/linking/`; both are denied. The most conservative reading also denies `src/shell/**` (app chrome +
  AuthGate, mirrored from the web shell and pinned by `check-shell-pins.mjs`), `src/auth/**` and `src/config/**` (the
  web deny list already excludes auth), and `src/ports/**` (the `@vitana/core` boundary to web code).
- `apps/mobile/app.json` does not exist today (the app uses `app.config.ts`); both are denied, plus `eas.json`.
  These files are outside `apps/mobile/src/**` and so already outside the class; they are listed explicitly as the plan asks.
- Generated: `*.generated.*` and `.generated/` under `apps/mobile/src` (e.g. `src/i18n/catalog-map.generated.ts`).
- The existing fixture `apps/mobile/src/x.tsx` (old contract) is replaced with `apps/mobile/app.json` instead of being
  deleted, so the case and assertion counts stay the same; no weakening declared.
- `sparring_record` points at `docs/validation/VTID-05767/plan-sparring.md` (a copy of the plan's verdict) because
  PR-GATE reads the record from this repository's checkout and the plan's `sparring/verdict.md` lives in vitana-platform.
- vitana-v1 `CLAUDE.md` "Plan Sparring Gate" item 2 still names `src/**`, `public/**` and staging specs only; that
  text is outside this lane's paths (lane `rules-v1` of the same plan owns the rule text).

## Not verified on staging
CI-only PR-GATE classifier change, deploys nothing; covered by `scripts/ci/pr-gate/__tests__` (run in PR-GATE).
