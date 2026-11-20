---
lane: translations
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
  - src/i18n/tr/screens.json
  - src/i18n/tr-screens-no-empty-values.test.ts
  - docs/validation/**
updated: 2026-11-11T12:56Z
vtid: VTID-05728
---
# Fill the two empty Turkish strings
Plan: `.kiro/specs/native-followups-20261111/` — `plan.md` and the `tasks.md` section marked `<!-- lane: translations -->` are authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.

**Goal.** `src/i18n/tr/screens.json:6777` (`screens.profile.dancePreferences`) and `:8145` (`screens.sharing.stressLevels`) are empty. Translate from the de/en source. The German `agreeExplanation` "Sie" is held back (two existing tests assert it; see `plan.md`) and is not in this lane.

**Acceptance:** the `tasks.md` lane `translations` Acceptance bullets. Checks: a new no-empty-values test (red on base); `npx vitest run src/i18n src/lib/commerce-terms.vtid-04895.test.ts src/components/commerce/PartnerTermsSheet.vtid-04909.test.tsx` green.

**Never.** no change to `src/i18n/de/**` or to the two terms tests. No VTID by hand, no merge or approve, no workflow dispatch or deploy, no write to Supabase, AWS or any live system, no test against production; the native app has no production profile.

## Log
### 2026-11-11T12:40Z · kiro-exafyltd-202611072144-1c88 · ready
Lane created with the plan.

### 2026-11-11T12:56Z · ci-plan-spar · ready (VTID allocated)
VTID-05728 allocated after policy approval (converged-auto-v1).
