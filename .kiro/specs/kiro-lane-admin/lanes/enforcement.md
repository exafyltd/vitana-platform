---
lane: enforcement
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
area: frontend
reviewer_seat: agent:vitana-lane-reviewer
updated: 2026-10-29T10:55Z
---
# Lane `enforcement`: the single enforcement point, tests, JSON+builtin, PM mirror
Plan: `.kiro/specs/kiro-lane-admin/` — `plan.md` and the `tasks.md` section `<!-- lane: enforcement -->` are
authoritative. Design: `design.md` §1-§5, §7. VTID: assigned by CI after PLAN-SPAR converges; do not start before
`vtid:` is set here.

**Paths (declared at build time, not here):** `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`,
`scripts/collab/protected-gate-files.json`, `services/gateway/src/services/project-manager/governance.ts` (+ its Jest
test), `docs/validation/VTID-*/**`. `paths` are intentionally NOT declared in this `plan(` lane file because the
current `validateLane` rule refuses an `executor: kiro` lane that declares a protected-gate path (`queue.mjs`,
`protected-gate-files.json`) — the very rule this plan repairs (bootstrap, see `handoff.md`). The narrow paths above
are authoritative for the build; they are added when the lane goes `executing`, and the build/merge proceeds under the
owner-instruction authority recorded in `plan.md`/`handoff.md` (§3a protected-gate merge).

Adds the reviewed, auditable Kiro lane-administration path to `scopeCheck` (a `lane_admin: true`, reviewer-agent-gated,
trusted-source lane may change lane PERM fields) and `validateLane` (the `lane_admin` marker), and removes the retired
"legacy claude review" protected-gate authority from the JSON description, the builtin comment and the PM
`governance.ts` mirror. Preserves the protected-gate refusal and the seat-ownership check unchanged. Tests red-on-base
first; all existing green.

**Protected gate file (§3a):** this lane changes `scripts/collab/queue.mjs` and
`scripts/collab/protected-gate-files.json` (and the PM `governance.ts` mirror). Merge only on the owner's instruction
naming this plan (recorded in handoff.md) plus a reviewer-agent accept on the current head — never a reviewer-agent
accept alone, never routed to Claude. **Bootstrap:** Collab handoff / Lane scope are red-by-construction here (today's
rule refuses these governance+protected paths from a non-claude lane); the reviewer confirms every red line is that old
refusal and nothing else, logged with the run URL.

## Log
### 2026-10-29T10:45Z · kiro-jtadic-202610291040-a0e6 · created → ready
Lane drafted with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat `jtadic` claims it.
