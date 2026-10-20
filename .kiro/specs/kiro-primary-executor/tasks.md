# Tasks — kiro-primary-executor

<!-- lane: rules-platform-autonomy -->
## Lane `rules-platform-autonomy`
Start only after `retire-claude-code/scope-rules`, `rules-platform` and `rules-v1` are merged (plan "Order").
- [ ] R1 `collaboration.md`: §7d (plan §A–§D); §7/§7a point at it; §7b kept for governance lanes; §8 automations.
- [ ] R2 `CLAUDE.md`: Autonomy contract stop list → §D + five-part format; roles paragraph names §7d.
- [ ] R3 `.kiro/steering/vitana-load-project-rules.md`, `vitana-kiro-notes.md`: role text, "never" list = §C.
- [ ] R4 `.kiro/automations/{exafy,exafyltd,jtadic}.md`: step 1/6 per §C/§D; Reviewer B; new item D; order A, B, D, C.
- [ ] R5 `docs/validation/<VTID>/` (plan-sparring, scope.json, acceptance.md); PR body carries the account-level
      steering text for the owner.

**Acceptance:** requirements 1–7 hold in the text; `queue.mjs validate` and `scripts/ci/kiro-steering/guard.cjs` green;
grep shows no routine hand-back to Claude Code, no production dispatch outside Gate 2, no session-tool live write;
sha256 of `collaboration.md` in the PR body.

<!-- lane: rules-v1-autonomy -->
## Lane `rules-v1-autonomy`
- [ ] V1 `collaboration.md` byte-identical to `rules-platform-autonomy`; V2 `CLAUDE.md` roles paragraph; V3 the two
      steering files; V4 `docs/validation/<VTID>/`.

**Acceptance:** sha256 equal to the platform copy; `queue.mjs validate` green; same grep as above.
