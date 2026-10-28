# Tasks — remove-b12-claude-sparring-gate1
Authoritative plan: `plan.md` (between the plan markers). VTIDs: allocated by CI PLAN-SPAR after policy approval;
never by hand. Branch `kiro/remove-b12-claude-sparring-gate1/<lane>`, PR title
`VTID-xxxxx (remove-b12-claude-sparring-gate1/<lane>): …`, trailers `Collab-Session` + `Collab-Lane` on every commit,
identity `kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/`
(`acceptance.md`, `commands.log`, `scope.json`). Squash merge under §7b. Acceptance below is what the reviewer agent
`vitana-lane-reviewer` checks. The exact replacement wording is the interface in `plan.md` §3 (I1-I6); both repos end
byte-identical.

<!-- lane: platform-governance -->
## Lane `platform-governance` — vitana-platform (executor: kiro, reviewer agent)
- [ ] P1 `.claude/rules/collaboration.md`: apply I5 (delete the Sparring-bullet sentence "Claude Code may still spar
      its own plans with its local partner; the owner then answers Gate 1 as before.") and I6 (drop the "(and Gate 1
      for a plan Claude Code sparred locally)" parenthetical from "The owner is asked only").
- [ ] P2 `.kiro/steering/vitana-owner-autonomy.md`: apply I1 (delete Stops row 12; renumber row 13 → 12; change both
      "stop 13" → "stop 12" in the "How to read the broad sentences" section). Table contiguous 1-12.
- [ ] P3 Evidence in `docs/validation/<VTID>/`: `acceptance.md` (grep + steering-check results), `commands.log`,
      `scope.json`.

**Acceptance**
- Change types: Tooling/docs
- Outcome: in `vitana-platform`, collaboration.md §7 states no Claude-Code-local-partner Gate 1 path, and the Stops
  table in vitana-owner-autonomy.md has no Gate-1/Claude-local row and numbers contiguously 1-12.
- The two "How to read" references read `stop 12`; no dangling `row 12` / `B12` / `stop 13`.
- grep (collaboration.md, vitana-owner-autonomy.md) for `local partner`, `locally sparred`, `sparred with its own`,
  `Gate 1 for a plan Claude Code`, `spar its own`, `sparred locally` → zero matches.
- `node scripts/collab/preflight.mjs …` passes on the lane branch; `kiro-web-steering --check` ok after merge.
- Only the lane paths change; no stop other than the B12 carve-out is touched; no other policy claim is contradicted.
<!-- lane: platform-governance -->

<!-- lane: platform-claude-md -->
## Lane `platform-claude-md` — vitana-platform (executor: claude; protected gate file CLAUDE.md; depends_on: platform-governance)
- [ ] C1 `CLAUDE.md`: apply I2 (delete the Autonomy Contract sentence "A plan Claude Code spars with its own local
      partner still goes to the owner as Gate 1."), I3 (rule 2b → "(rules 51–55): CI policy `converged-auto-v1`."),
      I4 (§4.1 → "CI policy `converged-auto-v1` for a `plan(` PR"). No other line changes.
- [ ] C2 Evidence in `docs/validation/<VTID>/`: `acceptance.md`, `commands.log`, `scope.json`. Record in the lane log:
      `authority: §7b PM rule + owner named-plan instruction (protected gate file CLAUDE.md)` for the merge.

**Acceptance**
- Change types: Tooling/docs
- Outcome: in `vitana-platform/CLAUDE.md`, the Autonomy Contract no longer says a Claude-Code locally-sparred plan
  goes to the owner as Gate 1; rule 2b and §4.1 present CI policy `converged-auto-v1` as the plan-approval path with
  no local-partner carve-out. Autonomy Contract + rule 2b + §4.1 + collaboration.md §7 all agree.
- grep (CLAUDE.md) for `local partner`, `locally sparred`, `sparred with its own`, `Gate 1 for a plan Claude Code`,
  `spar its own`, `sparred locally` → zero matches.
- `node scripts/collab/preflight.mjs …` passes; Lane scope passes (the lane is `executor: claude`, so the protected
  gate file CLAUDE.md change is allowed).
- CLAUDE.md is a protected gate file: the merge relies on the owner's named-plan instruction this session, recorded in
  the lane log and `decisions.md` — not the reviewer-agent accept alone.
- Only the lane paths change.
<!-- lane: platform-claude-md -->

<!-- lane: v1-governance -->
## Lane `v1-governance` — vitana-v1 (executor: kiro, reviewer agent; depends_on: platform-governance)
- [ ] V1 `.claude/rules/collaboration.md`: apply I5 and I6 exactly as merged in `platform-governance`, so the v1 copy
      stays byte-identical to the platform copy.
- [ ] V2 `.kiro/steering/vitana-owner-autonomy.md`: apply I1 exactly as merged in `platform-governance`, so the v1
      copy stays byte-identical (same contiguous 1-12 table, same "stop 12" references).
- [ ] V3 Evidence in `docs/validation/<VTID>/`: `acceptance.md`, `commands.log`, `scope.json`. No CLAUDE.md edit in
      v1 (stale; nothing to remove — confirm with a grep showing no carve-out there).

**Acceptance**
- Change types: Tooling/docs
- Outcome: in `vitana-v1`, collaboration.md §7 and the Stops table are byte-identical to the merged platform copies;
  no Gate-1/Claude-local carve-out remains; `vitana-v1/CLAUDE.md` is NOT edited.
- `diff vitana-platform/.claude/rules/collaboration.md vitana-v1/.claude/rules/collaboration.md` and the same for
  `vitana-owner-autonomy.md` show the edited lines are identical across repos.
- grep (collaboration.md, vitana-owner-autonomy.md) for the same six phrases → zero matches; Stops table contiguous
  1-12.
- `node scripts/collab/preflight.mjs …` passes on the lane branch; `kiro-web-steering --check` ok after merge.
- Only the lane paths change.
<!-- lane: v1-governance -->
