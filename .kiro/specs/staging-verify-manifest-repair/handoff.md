---
slug: staging-verify-manifest-repair
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-07T14:43Z
sparring_record: .kiro/specs/staging-verify-manifest-repair/sparring/verdict.md
vtids: [VTID-05600, VTID-05601, VTID-05602, VTID-05603, VTID-05604, VTID-05605, VTID-05606]
---
# Handoff - staging-verify-manifest-repair
Owner task 2026-11-07: repair the 14 tests that fail the nightly full gateway STAGING-VERIFY without weakening any
probe. Plan block: `plan.md`. Lanes: `console-probes-a`, `console-probes-b`, `ref-05331`, `pm-mode-probes`,
`shadow-retired`, `locale-zh-gap` (parallel) and `drift-guard` (after the four fix lanes).

## Log

### 2026-11-07T14:40Z · kiro-hotmail-202611061752-cc1f · drafted
Pushed as a `plan(` PR for CI PLAN-SPAR.

### 2026-11-07T14:43Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 7 lane(s) got a VTID and are handed to Kiro.

### 2026-11-07T14:50Z · kiro-hotmail-202611061752-cc1f · approved
Sparring converged in 2 rounds (policy converged-auto-v1); VTID-05600..05606 allocated by CI. Pushing this log line so the checks run on the bot-pushed head, then merging the spec-only plan PR under the 7b rule.
