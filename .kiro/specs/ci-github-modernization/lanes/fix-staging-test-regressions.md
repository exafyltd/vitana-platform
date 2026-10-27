---
lane: fix-staging-test-regressions
state: ready
next_actor: claude
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: agent:vitana-lane-reviewer
claimed_by: kiro-exafy-202610231320-f5b5
branch: kiro/ci-github-modernization/fix-staging-test-regressions
repos: [vitana-platform]
paths:
  - docs/validation/**
  - services/gateway/specs/loop-catalog-v1.json
  - services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts
updated: 2026-10-23T13:20Z
vtid: VTID-05308
---
# Lane: fix-staging-test-regressions
Fix-forward lane for the three gateway Jest regressions introduced when the ci-github-modernization lanes
(stale-tests, ci-health) were merged to `main` before the reviewer could verify them end to end. Non-governance
files only (a validation manifest, the loop catalog spec, one test file), so `executor: kiro` (seat `exafy`,
reviewer `agent:vitana-lane-reviewer`). PR-GATE's test-weakening guard is the backstop: assertions are repointed at
the current contract, none deleted or loosened.

## The three regressions
- **vtid-04659** (`services/gateway/test/vtid-04659-staging-checks-use-versioned-urls.test.ts` — *no staging http
  check reads a versioned Command Hub asset at its bare URL*): the stale-tests lane rewrote
  `docs/validation/VTID-05082/staging-tests.json` so the svg-preview.js http check read the BARE asset URL. The
  VTID-04659 guard forbids a staging check on a versioned asset at its bare path (the CDN caches bare URLs for a
  year). Fix: pin the check's `path` to the versioned URL `index.html` serves (`?v=20261121-vtid-05082`). The
  `expect_body_contains` (`sanitizeSvgMarkup`, `SvgPreview`) and the reason are unchanged; nothing deleted or
  weakened. Note: this re-introduces the versioned token *in the one svg-preview check only*, which is required by
  the VTID-04659 contract — the stale-tests lane's broader de-versioning is what tripped the guard.
- **loop-catalog** (`services/gateway/test/loop-catalog.test.ts` — *workflows: no orphans, nothing owned twice*): the
  ci-health lane added `.github/workflows/CI-HEALTH.yml` (a scheduled workflow) without a loop owner. Fix: register
  `CI-HEALTH` under L2 Build & Release (the CI/release loop) in `services/gateway/specs/loop-catalog-v1.json`.
  `SCHEDULED_WORKFLOWS` in `ops-runtime-health.ts` is derived dynamically from the test catalog (capped at 30) and
  needs no manual entry; `FALLBACK_SCHEDULED_WORKFLOWS` is pinned at 5 by vtid-05141 and left untouched.
- **vtid-04868** (`services/gateway/test/vtid-04868-plan-sparring-session-layer.test.ts` — *CLAUDE.md carries rules
  51-55 and puts allocation after sparring*): VTID-05280 (trim CLAUDE.md to project-specific rules) deliberately
  removed the standalone line `Step 0 (VTID-04868): spar the plan first.`; the test still pinned it. CLAUDE.md is a
  protected gate file and the trim was intentional, so the test is repointed — not the doc — at the durable §4.1
  wording that carries the same contract (`### 4.1 Allocation (STANDING RULE — VTID-03448, VTID-04868)` and
  `allocated only after its plan is sparred and approved`). Intent ("allocation after sparring") preserved.

## Log
### 2026-10-23T13:20Z · kiro-exafy-202610231320-f5b5 · executing
Fix-forward lane created and claimed. Implemented the three fixes at cause; red→green proven locally per file in
`services/gateway` (jest): vtid-04659 and loop-catalog green; the vtid-04868 CLAUDE.md case green (the two bash-hook
cases in that file fail only locally — they `execFileSync('bash', …)` a `.sh` hook that needs `jq`, absent on this
Windows machine, and pass on CI's ubuntu runner). Evidence under `docs/validation/VTID-05308/fix-forward-acceptance.md`.
Next: the reviewer agent reviews on the current head; the land step merges under §7b once CI is green.
