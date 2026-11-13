# VTID-05792 — operator bootstrap pack starts the rules at CLAUDE.md PART 1

Change types: Backend

Outcome: `extractClaudeMdPart1` in `services/gateway/src/services/operator-bootstrap-pack.ts` starts the governance
rules slice at the `# PART 1` header instead of the top of CLAUDE.md, so the Autonomy Contract preamble is no longer in
the operator bootstrap pack. The bound stays at `LIMITS.rulesChars` (12,000 characters).

Owner decision: VTID-04018, approving the change in the PR body.

Note: the owner-approved change does not turn a failing test green on its own. The Jest run in
`outputs/jest-vtid-04018.txt` is the evidence, and it was run on this branch's head with no test edited.

AC-1 — the rules slice starts at `# PART 1: CORE RULES (Always / Never / If–Then)` and does not start at the file start
  TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts — "extracts CLAUDE.md Part 1 (the rules), bounded, and never the change log" (asserts the slice contains `# PART 1: CORE RULES`; it checks presence, not that the slice starts at that header)

AC-2 — the slice is bounded by `LIMITS.rulesChars` and stops at `# PART 2`
  TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts — "extracts CLAUDE.md Part 1 (the rules), bounded, and never the change log" (asserts no `# PART 2` and length ≤ 12_000 + 20)

AC-3 — when the `# PART 1` header is missing, the slice falls back to the file start, clipped to the bound
  TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts — "extracts CLAUDE.md Part 1 (the rules), bounded, and never the change log" (`extractClaudeMdPart1('no marker here', 5)` returns `'no ma\n…[abridged]'`)

Staging proof: Jest only. The suite pins the function and the pack wiring. It does not call staging.
Command evidence: outputs/jest-vtid-04018.txt (16 passed, 16 total).
