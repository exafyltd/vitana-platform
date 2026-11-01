---
lane: whats-new-golden-regen
state: ready
next_actor: kiro
depends_on: []
executor: kiro
seat: jtadic
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - services/gateway/test/golden/v1-golden-edge.*
updated: 2026-11-01T15:40Z
repos: [exafyltd/vitana-platform]
---
# whats-new-golden-regen — regenerate the v1-golden-edge fixture (repo vitana-platform) — mt-packs-r2

Plan: `../plan.md`. Tasks, paths and acceptance: `../tasks.md` (`<!-- lane: whats-new-golden-regen -->`). The VTID
comes from PLAN-SPAR on convergence, never by hand.

Scope: CROSS-SPEC O3. This lane regenerates `services/gateway/test/golden/v1-golden-edge.*` with the documented
regenerate script in `scripts/mt/golden/`, as a declared and reviewed golden update for the neutral drafter prompt.
It does not hand-edit the fixture.
- **External dependency:** the fixture and the script do not exist on `origin/main` today (verified 2026-11-01).
  `mt-guardrails-r2` lane `maxina-golden-suite` builds them, and this lane starts only after that lane is `done`.
- **Cross-repo order:** `whats-new-drafter-prompt` (vitana-v1) is merged first. This is a stated reference, not a
  `depends_on` id.

Rules (§7a):
- No VTID allocation, no merge outside §7b, no live write.
- Branch: `kiro/mt-packs-r2/whats-new-golden-regen`.
- PR title: `VTID-xxxxx (mt-packs-r2/whats-new-golden-regen): …`.
- Trailers: `Collab-Session` + `Collab-Lane: mt-packs-r2/whats-new-golden-regen`.

## Log
### 2026-11-01T15:40Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-packs/whats-new-golden-regen`. The executor moves from claude to kiro. This lane waits for
`mt-guardrails-r2` `maxina-golden-suite`.
