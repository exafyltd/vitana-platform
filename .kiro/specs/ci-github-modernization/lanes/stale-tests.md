---
lane: stale-tests
state: executing
next_actor: kiro
depends_on: []
executor: kiro
seat: exafy
reviewer_seat: jtadic
claimed_by: kiro-exafy-202610211421-e550
branch: kiro/ci-github-modernization/stale-tests
repos: [vitana-v1, vitana-platform]
paths:
  - src/components/messages/ConversationView.deeplink-scroll.vtid-05201.test.tsx
  - src/components/messages/ConversationView.tsx
  - docs/validation/**
updated: 2026-10-21T14:35Z
vtid: VTID-05308
---
# Lane: stale-tests

Fix the permanently-red suites at the cause, never by skipping: vitana-v1 ConversationView VTID-05201
deeplink-scroll test (+ the ConversationView product code it asserts), and the platform VTID-05082
staging-contract failure (update the contract/`staging-tests.json` to today's AWS/Aurora/route state;
read-only). Tasks T1–T3 in `tasks.md`. The only straightforward Kiro lane — product + non-governance test
files, so `executor: kiro` (seat `exafy`, reviewer `jtadic`). PR-GATE's test-weakening guard is the
backstop: assertions change to the current contract, none deleted/loosened. No VTID yet.

Note: the vitana-v1 `paths` globs are the lane's v1-repo scope; the platform VTID-05082 evidence lands
under `docs/validation/**` in the lane's platform PR. Confirm the exact product-code file the v1 test
drives before editing (ConversationView may compose sub-components).

## Log

### 2026-10-21T11:20Z · kiro-hotmail-202610210852-0b8e · ready
Lane created with the plan. Scope: the v1 ConversationView test + its product code, the platform
VTID-05082 contract under docs/validation. Evidence from inv-tests §8 (both files confirmed on
origin/main). Non-governance Kiro lane. No VTID yet.

### 2026-10-21T12:26Z · ci-plan-spar · ready (VTID allocated)
VTID-05308 allocated after policy approval (converged-auto-v1).

### 2026-10-21T14:35Z · kiro-exafy-202610211421-e550 · executing
Claimed in both repos (vitana-platform, vitana-v1). Implemented at cause:

- **T1 (vitana-v1):** the VTID-05201 deeplink-scroll test was red on origin/main
  because its `@/lib/i18n-toast` mock omitted `getI18nLocale`, which
  ConversationView calls transitively (formatDate → locale-format →
  currentBcp47 → getI18nLocale) while rendering date dividers, throwing before
  the deep-link scroll assertion ran. Fix: added `getI18nLocale: () => 'de-DE'`
  (the module's default locale) to the mock. Product code (ConversationView.tsx)
  was already correct — the component already calls
  `scrollIntoView({behavior:'auto',block:'center'})` — so the cause was the
  stale mock, not the product. Red→green proven locally:
  `npx vitest run …ConversationView.deeplink-scroll.vtid-05201.test.tsx`
  FAIL(exit 1) on base → PASS(exit 0) on head. No assertion/case removed, no
  skip added (PR-GATE weakening guard: cases 1→1, expects 1→1, skips 0→0).
- **T2 (vitana-platform):** docs/validation/VTID-05082/staging-tests.json pinned
  the transient `?v=20261121-vtid-05082` cache token in two read-only assertions,
  which any later Command Hub ?v= bump turns permanently red in the STAGING-VERIFY
  nightly full run. Fix: assert the durable contract instead — index.html wires
  both `svg-preview.js` and `operator-console.js`; the served svg-preview.js
  (stable path; express.static ignores the query) contains `sanitizeSvgMarkup`
  and `SvgPreview`. No test deleted; renderer check strengthened. Verified by
  source-substring presence on base, static-serving semantics, and
  `validateManifest` ok. Live-staging HTTP is not probed (rule 48).
- **T3:** evidence under docs/validation/VTID-05308/ in both repos
  (contract.md, commands.log; red-on-base.txt in v1).

Note: ConversationView.tsx is in the lane `paths` but needed no edit — the
deep-link behaviour already matches the asserted contract; the only cause was
the test mock. (Decision recorded in RUN/decisions.md.)

### 2026-10-22T11:17:11Z · agent-vitana-lane-reviewer-202610221117-f7d5 · review
review: accept
head: 5c216e66635bafe7436c339388d8dd779b92153d
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4258 (v1 companion: https://github.com/exafyltd/vitana-v1/pull/1479 @ f869f7503941372110d3503bdca9f22a7e607dcc)
Findings: none blocking. Notes: v1 PR is evidence-only because main's VTID-05313 already carries the identical fix; the platform manifest drops the transient ?v= pin and strengthens the renderer assertion, with no test deleted or loosened; the earlier validate-pr failure was superseded by a green rerun on the same head; no protected gate files changed.
Next: the land step merges under §7b
