# VTID-05059 - Kiro IDE steering files link the standing rules (both repos)

Owner approval 2026-10-10 (Gate 1: "Yes"). Sparring: `plan-sparring.md` (converged, 2 rounds).

Change class: standard (docs/config + one PR-GATE step). Nothing deploys: no Gate 2; done when merged with green checks.

## Acceptance criteria

AC-1: `.kiro/steering/vitana-standing-rules.md` (inclusion always) links `CLAUDE.md` and `.claude/CLAUDE.md` with `#[[file:…]]`; no rule text is copied.
  TEST: scripts/ci/kiro-steering/guard.test.cjs ("this repository passes")
AC-2: every `.claude/rules/*.md` has a `.kiro/steering` twin with `inclusion: fileMatch` and `fileMatchPattern` equal to its `paths:`; every `#[[file:…]]` link resolves.
  TEST: scripts/ci/kiro-steering/guard.test.cjs (8 cases: pass, missing twin, glob drift, missing link target, no always file, twin not fileMatch, this repo)
AC-3: PR-GATE runs the guard and its self-test on every PR (outcome `kiro-steering` in the verdict, under the gate's existing report-only/enforce switch).
  TEST: .github/workflows/PR-GATE.yml step "Kiro steering"
AC-4: `vitana-kiro-notes.md` (inclusion always) states that sparring is never skipped in Kiro and how to load context.
  TEST: scripts/ci/kiro-steering/guard.test.cjs ("the Kiro notes say plan sparring is never skipped")
