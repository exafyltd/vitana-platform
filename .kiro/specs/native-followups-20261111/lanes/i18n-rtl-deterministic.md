---
lane: i18n-rtl-deterministic
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
reviewer_seat: agent:vitana-lane-reviewer
area: frontend
repos: [exafyltd/vitana-v1]
paths:
  - apps/mobile/tests/settings/i18n-rtl.test.tsx
  - docs/validation/**
updated: 2026-11-11T12:56Z
vtid: VTID-05724
---
# Make `tests/settings/i18n-rtl.test.tsx` deterministic
Plan: `.kiro/specs/native-followups-20261111/` — `plan.md` and the `tasks.md` section marked `<!-- lane: i18n-rtl-deterministic -->` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Goal.** The Arabic test holds an element across an async re-render (`:103`) and fails under load with `Unable to find node on an unmounted component` (CI `sh-ci2.log:27139`). Re-query inside `waitFor`, keep every assertion, no timeout raise as the only fix.

**Acceptance:** the `tasks.md` lane `i18n-rtl-deterministic` Acceptance bullets. Checks: 5 passes alone, 3 under CPU load, full suite green; the number of tests and `expect` calls is not lower than on base.

**Never.** no app code change; no assertion removed, weakened or skipped. No VTID by hand, no merge or approve, no workflow dispatch or deploy, no write to Supabase, AWS or any live system, no test against production; the native app has no production profile.

## Log
### 2026-11-11T12:40Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-11T12:56Z · ci-plan-spar · ready (VTID allocated)
VTID-05724 allocated after policy approval (converged-auto-v1).
