---
slug: mt-guardrails-r2
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-01T15:30Z
---
# Handoff — mt-guardrails-r2
Re-plan of `mt-guardrails` (PR #4162, closed 2026-10-28; session `496d49e4` escalated at the round cap). WS0 guard
rails and test tooling for the multi-tenant program: local stack + fixtures, generated inventories and DB lints,
pgTAP isolation suite, gateway scope lint and contract tests, Maxina golden suite, CI wiring. Plan: `plan.md`.

## Log

### 2026-11-01T15:30Z · kiro-hotmail-202611011402-f523 · drafted
Owner instruction 2026-11-01: "you make the decisions for me". Re-planned instead of approved as escalated. Round-3
findings answered in `plan.md` "Re-plan answers": no GitHub Actions `services:` container (R3-F1), no production
schema dump — the schema is a local replay of the committed migrations (R3-F2), the vulnerable-pin caveat recorded
(R3-F3). `ci-wiring` moves to `executor: kiro` under §3a on `main`. Pushed as a `plan(` PR.
