# VTID-05204 — Commerce UX contract as a standing rule (docs/rules only)

Owner rule 2026-10-15; owner approval of the sparred plan 2026-10-15 ("Approved."). Sparring: `plan-sparring.md`
(CONVERGED, 2 rounds, light class). One VTID for both repos. Docs/rules only: no code, no route, no migration,
no deploy, no OASIS event. Nothing deploys, so there is no Gate 2; done when both PRs merge with green checks.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: `exafyltd/vitana-v1` `CLAUDE.md` carries the section "Commerce UX contract — supplier onboarding (VTID-05204)"
between "Voice navigation — the screen registry" and "Key Patterns", with the exact approved wording.
  TEST: grep -n "## Commerce UX contract — supplier onboarding (VTID-05204)" CLAUDE.md
AC-2: `exafyltd/vitana-platform` `.claude/rules/backend.md` "Standing rules for any Commerce change" ends with rule 9
(VTID-05204), immediately after rule 8 and before the section separator, with the exact approved wording.
  TEST: grep -n "9. \*\*The API serves the AI-led, low-friction onboarding UX (VTID-05204" .claude/rules/backend.md
AC-3: No other file content changes: the diff is the one rule file plus `docs/validation/VTID-05204/**` in each repo.
  TEST: git diff --stat origin/main...HEAD
AC-4: Out of scope and not present: country/website inference, "Your assistant can do this", PR-template or CI
enforcement of the UX acceptance section (raised as separate follow-up plans after merge).
  TEST: git diff --name-only origin/main...HEAD  (only the rule file + docs/validation/VTID-05204/**; no src/, services/ or .github/ path)

This repo's file: `.claude/rules/backend.md`.
