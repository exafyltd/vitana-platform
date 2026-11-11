# Tasks — session-handover-gitlab
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/session-handover-gitlab/<lane>`; trailers
`Collab-Session`, `Collab-Lane`; author `kiro-agent[bot]`; evidence in `docs/validation/<VTID>/`.

<!-- lane: claude-md-platform -->
## Lane `claude-md-platform`
- [ ] T1 `scripts/collab/session-handover-rule.test.mjs` first, red on `origin/main`.
- [ ] T2 Insert the plan §3 section in `CLAUDE.md` after the collaboration section, text exactly as in the plan.
- [ ] T3 Test green, `node --test scripts/collab/*.test.mjs`, steering guard, preflight.

**Acceptance**
- Change types: Tooling/docs.
- Only `CLAUDE.md`, the test and the evidence change; the section text equals plan §3; no other line of `CLAUDE.md` changes.
- Protected gate file: owner instruction (plan §1) plus an accept from reviewer seat `exafyltd` on the current head.

<!-- lane: claude-md-v1 -->
## Lane `claude-md-v1`
- [ ] T1 `src/lib/claude-md-session-handover.test.ts` first, red on `origin/main`.
- [ ] T2 Insert the same section in vitana-v1 `CLAUDE.md` after its collaboration section.
- [ ] T3 Test green, `npm test`.

**Acceptance**
- Change types: Tooling/docs.
- Only `CLAUDE.md`, the test and the evidence change; the section text equals plan §3; no other line changes.
