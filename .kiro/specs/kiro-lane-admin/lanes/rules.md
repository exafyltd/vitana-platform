---
lane: rules
state: ready
next_actor: kiro
depends_on: [enforcement]
executor: kiro
seat: jtadic
area: frontend
reviewer_seat: agent:vitana-lane-reviewer
repos: [exafyltd/vitana-platform, exafyltd/vitana-v1]
updated: 2026-10-29T11:49Z
vtid: VTID-05409
---
# Lane `rules`: human-facing rule text, consistently Claude-free
Plan: `.kiro/specs/kiro-lane-admin/` — `plan.md` and the `tasks.md` section `<!-- lane: rules -->` are authoritative.
Design: `design.md` §6. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
Depends on `enforcement` being on `main` so the rule text matches what code enforces.

**Paths (declared at build time, not here):** `.claude/rules/collaboration.md`, `CLAUDE.md`,
`.kiro/pipeline/common-rules.md`, `.kiro/steering/vitana-owner-autonomy.md`, `docs/validation/VTID-*/**` (platform);
the byte-identical `CLAUDE.md` mirror in a sibling vitana-v1 PR. `paths` are not declared in this `plan(` lane file
because `CLAUDE.md` is a protected-gate path the current `validateLane` refuses on an `executor: kiro` lane (the rule
this plan repairs). Added when the lane goes `executing`; merge under the owner-instruction authority in `plan.md`.

Rewrites the protected-gate authority to "the owner's instruction naming the plan plus a reviewer-agent accept on the
current head" and adds one sentence on the authorized `lane_admin` reviewer-agent lane-administration path, in
`collaboration.md` (§3a/§7/§7a/§7b), `CLAUDE.md` (platform), `common-rules.md` rule 4 and `vitana-owner-autonomy.md`
stop #3. The byte-identical `vitana-v1/CLAUDE.md` mirror is carried in a sibling vitana-v1 PR of this lane (sha256 in
the PR body). `vitana-collaboration.md` stays a `#[[file:]]` link (no body edit).

**Protected gate file (§3a):** this lane changes `CLAUDE.md`. Merge only on the owner's instruction naming this plan
(handoff.md) plus a reviewer-agent accept on the current head. The other files are governance paths, satisfied by the
reviewer agent on the current head. `scripts/ci/kiro-steering/guard.cjs` must stay green.

## Log
### 2026-10-29T10:45Z · kiro-jtadic-202610291040-a0e6 · created → ready
Lane drafted with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat `jtadic` claims it (after `enforcement` is
`done`).

### 2026-10-29T11:49Z · ci-plan-spar · ready (VTID allocated)
VTID-05409 allocated after policy approval (converged-auto-v1).
