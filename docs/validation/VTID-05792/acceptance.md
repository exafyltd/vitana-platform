# VTID-05792 — operator bootstrap pack keeps the CLAUDE.md preamble ahead of the rules

Change types: Backend

Outcome: `extractClaudeMdPart1` in `services/gateway/src/services/operator-bootstrap-pack.ts` keeps the whole
CLAUDE.md preamble, including the Autonomy Contract, ahead of the `# PART 1: CORE RULES` header. The slice starts at
file offset 0 and stops at `# PART 2`. The bound stays at `LIMITS.rulesChars` (12,000 characters). This branch
restores the `main` version of the source file, so the source diff against `main` is empty.

Owner decision: VTID-04018, final: the bootstrap pack keeps the preamble. The earlier VTID-05792 slice that started at
`# PART 1` and dropped the preamble is reverted.

Measured on origin/main 4c4694b797 (`CLAUDE.md`, JS string index, UTF-8 byte offset in brackets):
- file start / preamble start: 0 [0]
- `## ⚙ AUTONOMY CONTRACT` heading: 1269 [1277]
- `## 🤝 CLAUDE CODE ↔ KIRO COLLABORATION` heading: 6443 [6474]
- `# PART 1: CORE RULES` heading: 8104 [8158]
- `# PART 2: TECHNICAL REFERENCE` heading: 41561 [41965]
- `LIMITS.rulesChars`: 12000

Arithmetic: the preamble before `# PART 1` is 8,104 characters. The bound leaves 3,896 characters after it, so the
`# PART 1` heading (ends at 8,124) falls inside the 12,000-character slice. The clip cuts the rules text after the
preamble and the first part of PART 1. The `NEVER` and `IF–THEN` sections of PART 1 are not in the slice. That
truncation exists on `main` already and is not changed by this branch.

AC-1 — the rules slice starts at file offset 0, so the Autonomy Contract preamble is in the slice
  TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts — "a failing or hanging source renders as unavailable and does not block the others" (asserts the governance-rules section body contains `# PART 1`)
  NOTE: no test asserts that the Autonomy Contract heading is present. The preamble is kept by the code (the slice starts at offset 0). Measured above, and checked on the `main` text: the slice contains `AUTONOMY CONTRACT`.

AC-2 — `# PART 1: CORE RULES` is inside the bounded rules text, and the slice stops at `# PART 2`
  TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts — "extracts CLAUDE.md Part 1 (the rules), bounded, and never the change log" (asserts the slice contains `# PART 1: CORE RULES`, does not contain `# PART 2` or `## CHANGE LOG`, and has length ≤ 12_000 + 20)

AC-3 — the governance-rules section is published under its title and the pack wiring is unchanged
  TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts — "builds every section from the injected sources" (asserts the section title `Governance rules (CLAUDE.md Part 1, abridged)` and that no section errors)

Staging proof: Jest only. The suite pins the function and the pack wiring. It does not call staging.
Command evidence: outputs/jest-vtid-04018.txt (16 passed, 16 total, run on this branch's head with no test edited).
